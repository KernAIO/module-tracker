import type { Page, Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { trackerEvents } from '../../contract/events.js'
import {
  type Comment,
  MODULE_ID,
  type ReactionSummary,
  type RichDoc,
  type SlaState,
} from '../../contract/models.js'
import { docToText, extractMentions, preview } from '../rich.js'
import { commentReactions, comments, issues } from '../schema.js'
import type { AccessService } from './access.js'
import { type CommentRow, issueUrl, toComment } from './db.js'
import type { IssueService } from './issues.js'
import type { NotifyService } from './notify.js'

export interface CreateCommentOptions {
  parentId?: string | null
  internal?: boolean
  source?: Comment['source']
  authorId?: string | null
  /** transition comments are already announced by the status change */
  silent?: boolean
}

export class CommentService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly issuesService: IssueService,
    private readonly notify: NotifyService,
  ) {}

  private async reactionsFor(tx: Tx, commentIds: string[]): Promise<Map<string, ReactionSummary[]>> {
    const map = new Map<string, ReactionSummary[]>()
    if (!commentIds.length) return map
    const rows = await tx.execute<{
      comment_id: string
      emoji: string
      count: string
      user_ids: string[]
    }>(sql`
      select ${commentReactions.commentId} as comment_id, ${commentReactions.emoji} as emoji,
             count(*)::int as count, array_agg(${commentReactions.userId} order by ${commentReactions.createdAt}) as user_ids
      from ${commentReactions}
      where ${commentReactions.commentId} = any(${sql.param(commentIds)}::uuid[])
      group by 1, 2 order by min(${commentReactions.createdAt})`)
    for (const r of rows.rows) {
      const list = map.get(r.comment_id) ?? []
      list.push({
        emoji: r.emoji,
        count: Number(r.count),
        userIds: r.user_ids as ReactionSummary['userIds'],
      })
      map.set(r.comment_id, list)
    }
    return map
  }

  private async hydrate(tx: Tx, rows: CommentRow[]): Promise<Comment[]> {
    const reactions = await this.reactionsFor(
      tx,
      rows.map((r) => r.id),
    )
    return rows.map((r) => toComment(r, reactions.get(r.id) ?? []))
  }

  async list(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<Comment>> {
    const issue = await this.issuesService.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, issue.projectId, 'tracker.issue.view')
    const filters = [eq(comments.workspaceId, workspaceId), eq(comments.issueId, issueId)]
    if (cursor) filters.push(gt(comments.id, cursor))
    const rows = await tx
      .select()
      .from(comments)
      .where(and(...filters))
      .orderBy(asc(comments.id))
      .limit(limit + 1)
    const page = rows.slice(0, limit)
    return {
      items: await this.hydrate(tx, page),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    }
  }

  async get(tx: Tx, workspaceId: string, commentId: string): Promise<CommentRow> {
    const [row] = await tx
      .select()
      .from(comments)
      .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId)))
      .limit(1)
    if (!row) throw KernError.notFound('Comment')
    return row
  }

  async create(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    body: RichDoc,
    opts: CreateCommentOptions = {},
  ): Promise<Comment> {
    const issue = await this.issuesService.row(tx, workspaceId, issueId)
    const authorId = opts.authorId ?? principal.userId ?? null
    if (!opts.silent && opts.source !== 'system')
      await this.access.requireProject(tx, principal, workspaceId, issue.projectId, 'tracker.issue.comment')

    // `parentId` arrives from the caller, so it is proved to be a comment on *this* issue in *this*
    // workspace before anything points at it. Without that, a reply threads itself under a stranger's
    // comment and the reply-count update below lands on another tenant's row.
    if (opts.parentId) {
      const parent = await this.get(tx, workspaceId, opts.parentId)
      if (parent.issueId !== issueId) throw KernError.notFound('Comment')
    }

    const bodyText = docToText(body)
    const mentionIds = extractMentions(body)
    const id = uuidv7()
    const [row] = await tx
      .insert(comments)
      .values({
        id,
        workspaceId,
        issueId,
        parentId: opts.parentId ?? null,
        authorId,
        body,
        bodyText,
        mentionIds,
        internal: opts.internal ?? false,
        source: opts.source ?? 'app',
      })
      .returning()

    if (opts.parentId)
      await tx
        .update(comments)
        .set({ replyCount: sql`${comments.replyCount} + 1` })
        .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, opts.parentId)))

    const watchers = new Set(this.issuesService.watchersOf(issue))
    if (authorId) watchers.add(authorId)
    await tx
      .update(issues)
      .set({
        commentCount: sql`${issues.commentCount} + 1`,
        watcherIds: [...watchers],
        lastActivityAt: new Date(),
        updatedAt: new Date(),
        sla: this.markFirstResponse(issue.sla as SlaState | null, authorId, issue.reporterId),
      })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))

    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: authorId,
      action: 'commented',
      data: { commentId: id, preview: preview(bodyText, 200) },
    })

    const comment = toComment(row!, [])
    if (!opts.silent) {
      await this.kernel.emit(
        trackerEvents.issueCommented,
        {
          workspaceId: workspaceId as Comment['workspaceId'],
          projectId: issue.projectId,
          issueId,
          key: issue.key,
          commentId: id,
          parentId: opts.parentId ?? null,
          authorId: authorId as Comment['authorId'],
        },
        { workspaceId, actorId: authorId },
      )
      await this.notify.notify({
        workspaceId,
        userIds: mentionIds,
        type: 'tracker.issue.mentioned',
        title: `You were mentioned in ${issue.key}`,
        body: preview(bodyText),
        object: { module: MODULE_ID, type: 'issue', id: issueId },
        url: issueUrl(issue.key),
        groupKey: issueId,
        actorId: authorId,
        exclude: [authorId],
      })
      const mentioned = new Set(mentionIds)
      await this.notify.notify({
        workspaceId,
        userIds: [...watchers].filter((w) => !mentioned.has(w)),
        type: 'tracker.issue.commented',
        title: `New comment on ${issue.key}`,
        body: preview(bodyText),
        object: { module: MODULE_ID, type: 'issue', id: issueId },
        url: issueUrl(issue.key),
        groupKey: issueId,
        actorId: authorId,
        exclude: [authorId],
      })
    }
    await this.notify.change(workspaceId, 'issue', issueId, 'updated', {
      scope: { projectId: issue.projectId },
    })
    return comment
  }

  /** The first reply from somebody other than the requester stops the first-response clock. */
  private markFirstResponse(
    sla: SlaState | null,
    authorId: string | null,
    reporterId: string | null,
  ): SlaState | null {
    if (!sla || sla.firstRespondedAt || !authorId || authorId === reporterId) return sla
    return { ...sla, firstRespondedAt: new Date().toISOString() }
  }

  async update(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    commentId: string,
    body: RichDoc,
  ): Promise<Comment> {
    const current = await this.get(tx, workspaceId, commentId)
    const issue = await this.issuesService.row(tx, workspaceId, current.issueId)
    const isAuthor = current.authorId && current.authorId === principal.userId
    if (!isAuthor)
      await this.access.require(principal, 'tracker.issue.edit_any', workspaceId, issue.projectId)
    const [row] = await tx
      .update(comments)
      .set({
        body,
        bodyText: docToText(body),
        mentionIds: extractMentions(body),
        editedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId)))
      .returning()
    await this.notify.change(workspaceId, 'issue', current.issueId, 'updated')
    return (await this.hydrate(tx, [row!]))[0]!
  }

  /** Soft delete: the row stays so reply counts and threading remain intact. */
  async delete(tx: Tx, principal: Principal, workspaceId: string, commentId: string): Promise<void> {
    const current = await this.get(tx, workspaceId, commentId)
    if (current.deletedAt) return
    const issue = await this.issuesService.row(tx, workspaceId, current.issueId)
    const isAuthor = current.authorId && current.authorId === principal.userId
    if (!isAuthor)
      await this.access.require(principal, 'tracker.issue.edit_any', workspaceId, issue.projectId)
    await tx
      .update(comments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId)))
    await tx
      .update(issues)
      .set({ commentCount: sql`greatest(0, ${issues.commentCount} - 1)` })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, current.issueId)))
    await this.notify.change(workspaceId, 'issue', current.issueId, 'updated')
  }

  async react(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    commentId: string,
    emoji: string,
  ): Promise<Comment> {
    const current = await this.get(tx, workspaceId, commentId)
    const issue = await this.issuesService.row(tx, workspaceId, current.issueId)
    await this.access.requireProject(tx, principal, workspaceId, issue.projectId, 'tracker.issue.comment')
    const userId = this.access.userId(principal)
    const deleted = await tx
      .delete(commentReactions)
      .where(
        and(
          eq(commentReactions.commentId, commentId),
          eq(commentReactions.userId, userId),
          eq(commentReactions.emoji, emoji),
        ),
      )
      .returning({ id: commentReactions.commentId })
    if (!deleted.length) await tx.insert(commentReactions).values({ commentId, workspaceId, userId, emoji })
    return (await this.hydrate(tx, [current]))[0]!
  }

  /** Latest comments of an issue, oldest first (email threading, digests). */
  async recent(tx: Tx, workspaceId: string, issueId: string, limit = 20): Promise<Comment[]> {
    const rows = await tx
      .select()
      .from(comments)
      .where(and(eq(comments.workspaceId, workspaceId), eq(comments.issueId, issueId)))
      .orderBy(desc(comments.id))
      .limit(limit)
    return this.hydrate(tx, rows.reverse())
  }
}
