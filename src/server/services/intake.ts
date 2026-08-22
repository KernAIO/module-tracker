import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx } from '@kernhq/kernel'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type {
  EmailIngestResult,
  InboundEmail,
  IntakeForm,
  IntakeSubmission,
  Issue,
} from '../../contract/models.js'
import { docToText, stripQuotedReply, textToDoc } from '../rich.js'
import { intakeTokens, issues, projects } from '../schema.js'
import type { AccessService } from './access.js'
import type { CommentService } from './comments.js'
import type { ConfigService } from './config.js'
import { parseSettings } from './db.js'
import type { IssueService } from './issues.js'
import type { NotifyService } from './notify.js'
import type { TransitionService } from './transitions.js'

const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/

/** Public intake form, triage queue actions and inbound email ingest. */
export class IntakeService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly issuesService: IssueService,
    private readonly comments: CommentService,
    private readonly transitions: TransitionService,
    private readonly notify: NotifyService,
  ) {}

  /**
   * Resolve a public token to its workspace without an RLS context. `intake_tokens` exists exactly
   * for this: an anonymous request carries nothing else to scope the query by.
   */
  async resolveToken(token: string): Promise<{ workspaceId: string; projectId: string }> {
    const [row] = await this.kernel.database.db
      .select()
      .from(intakeTokens)
      .where(eq(intakeTokens.token, token))
      .limit(1)
    if (!row) throw KernError.notFound('Intake form')
    return { workspaceId: row.workspaceId, projectId: row.projectId }
  }

  /** Keep the lookup table in step with `projects.intake_token`. */
  async syncToken(tx: Tx, workspaceId: string, projectId: string, token: string | null): Promise<void> {
    await tx.delete(intakeTokens).where(eq(intakeTokens.projectId, projectId))
    if (token) await tx.insert(intakeTokens).values({ token, workspaceId, projectId })
  }

  async form(token: string): Promise<IntakeForm> {
    const { workspaceId, projectId } = await this.resolveToken(token)
    return this.kernel.database.withWorkspace(workspaceId, async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
        .limit(1)
      if (!project || project.archivedAt) throw KernError.notFound('Intake form')
      return {
        projectId: project.id,
        projectName: project.name,
        token,
        title: `Contact ${project.name}`,
        description: project.description,
        fields: [
          { key: 'name', label: 'Your name', type: 'text' as const, required: false },
          { key: 'email', label: 'Email', type: 'email' as const, required: true },
          { key: 'title', label: 'Summary', type: 'text' as const, required: true },
          { key: 'description', label: 'Details', type: 'textarea' as const, required: false },
        ],
        allowAttachments: false,
      }
    })
  }

  async submit(input: IntakeSubmission): Promise<{ ok: true; issueKey: string }> {
    // the honeypot is a field real people never see, so anything in it is a bot
    if (input.website) throw KernError.badRequest('Rejected')
    const { workspaceId, projectId } = await this.resolveToken(input.token)
    const body = [
      input.description ?? '',
      '',
      ...Object.entries(input.fields ?? {}).map(([key, value]) => `${key}: ${String(value)}`),
      input.email ? `Reported by: ${input.name ? `${input.name} <${input.email}>` : input.email}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const issue = await this.kernel.database.withWorkspace(workspaceId, (tx) =>
      this.issuesService.create(
        tx,
        this.kernel.system,
        workspaceId,
        {
          projectId,
          title: input.title,
          description: textToDoc(body),
        },
        { source: 'intake', system: true, triage: true },
      ),
    )
    return { ok: true, issueKey: issue.key }
  }

  // ------------------------------------------------------------------ triage

  async accept(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    statusId?: string,
  ): Promise<Issue> {
    const row = await this.issuesService.row(tx, workspaceId, issueId)
    await this.access.require(principal, 'tracker.triage.manage', workspaceId, row.projectId)
    const target = statusId ?? (await this.transitions.firstNonTriageStatus(tx, workspaceId, issueId))
    const issue = await this.transitions.moveToStatus(tx, principal, workspaceId, issueId, target)
    await tx
      .update(issues)
      .set({ triage: false, snoozedUntil: null, updatedAt: new Date() })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: principal.userId ?? null,
      action: 'triage_accepted',
    })
    return { ...issue, triage: false, snoozedUntil: null }
  }

  async decline(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    comment?: string,
  ): Promise<Issue> {
    const row = await this.issuesService.row(tx, workspaceId, issueId)
    await this.access.require(principal, 'tracker.triage.manage', workspaceId, row.projectId)
    const project = await this.access.loadProject(tx, workspaceId, row.projectId)
    const cancelled = await this.cancelledStatus(tx, workspaceId, project.id, row.typeId)
    const issue = await this.transitions.moveToStatus(tx, principal, workspaceId, issueId, cancelled, {
      ...(comment ? { comment } : {}),
      resolution: 'declined',
    })
    await tx
      .update(issues)
      .set({ triage: false, updatedAt: new Date() })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: principal.userId ?? null,
      action: 'triage_declined',
    })
    return { ...issue, triage: false }
  }

  private async cancelledStatus(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    typeId: string,
  ): Promise<string> {
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
      .limit(1)
    if (!project) throw KernError.notFound('Project')
    const { definition } = await this.config.workflowFor(tx, project, typeId)
    const status =
      definition.statuses.find((s) => s.category === 'cancelled') ??
      definition.statuses.find((s) => s.category === 'done')
    if (!status) throw KernError.badRequest('This workflow has no cancelled status')
    return status.id
  }

  async snooze(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    until: string,
  ): Promise<Issue> {
    const row = await this.issuesService.row(tx, workspaceId, issueId)
    await this.access.require(principal, 'tracker.triage.manage', workspaceId, row.projectId)
    const [updated] = await tx
      .update(issues)
      .set({ snoozedUntil: new Date(until), updatedAt: new Date() })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
      .returning()
    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: principal.userId ?? null,
      action: 'triage_snoozed',
      data: { until },
    })
    return (await this.issuesService.hydrate(tx, [updated!]))[0]!
  }

  // ------------------------------------------------------------------ email ingest

  /**
   * Turn an inbound email into a new triage issue or a comment on the issue it replies to.
   * Threading is resolved by `In-Reply-To`/`References` first, then by an issue key in the subject.
   */
  async ingestEmail(input: InboundEmail): Promise<EmailIngestResult> {
    const location = input.projectToken
      ? await this.resolveToken(input.projectToken)
      : input.workspaceId && input.projectId
        ? { workspaceId: input.workspaceId, projectId: input.projectId }
        : null
    if (!location)
      return {
        action: 'ignored',
        issueId: null,
        issueKey: null,
        commentId: null,
        reason: 'no project token',
      }

    const { workspaceId, projectId } = location
    const text = stripQuotedReply(input.text ?? docToText(null) ?? '')
    const references = [...(input.references ?? []), input.inReplyTo ?? ''].filter(Boolean)

    return this.kernel.database.withWorkspace(workspaceId, async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
        .limit(1)
      if (!project || project.archivedAt)
        return {
          action: 'ignored' as const,
          issueId: null,
          issueKey: null,
          commentId: null,
          reason: 'unknown project',
        }

      const [duplicate] = await tx
        .select({ id: issues.id, key: issues.key })
        .from(issues)
        .where(and(eq(issues.workspaceId, workspaceId), eq(issues.externalRef, input.messageId)))
        .limit(1)
      if (duplicate)
        return {
          action: 'ignored' as const,
          issueId: duplicate.id,
          issueKey: duplicate.key,
          commentId: null,
          reason: 'already ingested',
        }

      let target: { id: string; key: string } | null = null
      if (references.length) {
        const [row] = await tx
          .select({ id: issues.id, key: issues.key })
          .from(issues)
          .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.externalRef, references)))
          .orderBy(desc(issues.createdAt))
          .limit(1)
        target = row ?? null
      }
      if (!target) {
        const match = ISSUE_KEY_RE.exec(input.subject)
        if (match) {
          const [row] = await tx
            .select({ id: issues.id, key: issues.key })
            .from(issues)
            .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, match[1]!)))
            .limit(1)
          target = row ?? null
        }
      }

      if (target) {
        const comment = await this.comments.create(
          tx,
          this.kernel.system,
          workspaceId,
          target.id,
          textToDoc(text || input.subject),
          { source: 'email', silent: false, authorId: null },
        )
        return {
          action: 'commented' as const,
          issueId: target.id,
          issueKey: target.key,
          commentId: comment.id,
        }
      }

      const settings = parseSettings(project.settings)
      const issue = await this.issuesService.create(
        tx,
        this.kernel.system,
        workspaceId,
        {
          projectId,
          title: input.subject.trim() || '(no subject)',
          description: textToDoc(
            [text, '', `From: ${input.from.name ?? ''} <${input.from.address}>`].join('\n').trim(),
          ),
          ...(input.attachments?.length ? { attachmentIds: input.attachments.map((a) => a.fileId) } : {}),
        },
        {
          source: 'email',
          system: true,
          externalRef: input.messageId,
          triage: settings.triage.enabled,
        },
      )
      return { action: 'created' as const, issueId: issue.id, issueKey: issue.key, commentId: null }
    })
  }

  /** Triage items whose snooze has expired become visible again. */
  async wakeSnoozed(workspaceId: string, now = new Date()): Promise<number> {
    return this.kernel.database.withWorkspace(workspaceId, async (tx) => {
      const rows = await tx
        .update(issues)
        .set({ snoozedUntil: null, updatedAt: now })
        .where(
          and(
            eq(issues.workspaceId, workspaceId),
            eq(issues.triage, true),
            sql`${issues.snoozedUntil} is not null and ${issues.snoozedUntil} <= ${now.toISOString()}`,
          ),
        )
        .returning({ id: issues.id })
      return rows.length
    })
  }
}
