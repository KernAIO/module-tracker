import type { core } from '@kernhq/contracts'
import type { Kernel, Tx } from '@kernhq/kernel'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { MODULE_ID } from '../../contract/models.js'
import { fieldDefs, issues, projectMembers, projects } from '../schema.js'
import { issueUrl } from './db.js'

const objectRef = (type: string, id: string) => ({ module: MODULE_ID, type, id })

/**
 * Who may see a tracker hit in workspace search.
 *
 * `SearchDocument.acl` is matched by core against `[userId, …groupIds, 'role:<role>']` — the
 * `subjects` array built in `core/src/modules/core/services/search.ts` — with
 * `(acl is null or acl && subjects)`. **`null` therefore means "everybody in the workspace"**,
 * which is what every issue was indexed with: a guest scoped to one project was served the key,
 * title and indexed description of every issue in every project.
 *
 * The value written here is `AccessService.assertAccess` said in that vocabulary. That method is two
 * gates, and each visibility makes one of them the one that decides:
 *
 * - a **workspace** project is gated only on holding `tracker.project.view` at project scope, whose
 *   `defaultRoles` are owner, admin, member and guest — and core's guest floor denies every
 *   project-scoped key to a guest at workspace level, so in practice it is the three role subjects
 *   below. Project membership grants nothing here, which is why member ids are deliberately absent:
 *   adding a guest to a workspace-visibility project does not let them open its issues, so it must
 *   not let them read its titles either.
 * - a **private** project adds a membership gate on top, and that gate is the narrow one — a
 *   workspace owner who is not a member is refused — so the acl is the member ids.
 *
 * The acl is denormalised onto each issue document, so it is only ever as fresh as the last
 * re-index. Everything that changes who may read a project therefore re-indexes that project's
 * issues: `projects.update` when the visibility moves, `addMembers`/`removeMember`, and the
 * `core.member.removed` subscription. `IssueService.reindex` on an issue mutation is not enough —
 * a project made private with nobody touching an issue afterwards kept every non-member's hit
 * (measured in `access.int.test.ts` before those call sites existed).
 *
 * **Three limits, stated rather than papered over. Two of them fail open.**
 *
 * 1. **A project-scoped deny binding fails open.** `core.roles.bind` stores a deny for any
 *    administrator who narrows somebody out of one project, and `Authz.can` honours it — so
 *    `issues.get` answers FORBIDDEN while the hit survives, because a workspace-visibility acl says
 *    `role:member` and the denied caller's subjects still contain `role:member`. Measured
 *    2026-09-06; `access.int.test.ts` asserts the leak so this paragraph and the behaviour cannot
 *    drift apart again.
 * 2. **The conjunction a private project really is fails open too.** The acl is a set *overlap*, so
 *    it cannot express "a member **and** a role that holds the permission": a guest who is a member
 *    of a private project matches the acl and is still refused when they open the hit. Nothing in
 *    the product writes that combination today — the tracker's project member list is the only
 *    thing that puts a guest on a project, and it grants no permission — but it is a leak, not a
 *    gap.
 * 3. A guest **scoped to a project by a role binding** finds nothing here, although opening the
 *    issue by key works. That one fails closed.
 *
 * Neither open limit is closable in this module, and the reason is the same for all three: an
 * overlap is *additive* and a deny is *subtractive*. Writing them down would mean an acl that
 * enumerates the readers rather than naming roles, which needs both the workspace member list and
 * an answer to "which subjects hold a binding on this scope" — `core.authz.bindings` answers the
 * opposite question, per user, and no procedure anywhere enumerates the other direction. The
 * alternatives both live in core: match a hit against the module's own visible-object set at query
 * time, or apply denies in `search()` alongside `subjects`.
 */
export const WORKSPACE_PROJECT_SUBJECTS = ['role:owner', 'role:admin', 'role:member'] as const

export function issueSearchAcl(visibility: string, memberIds: readonly string[]): string[] {
  return visibility === 'private' ? [...new Set(memberIds)] : [...WORKSPACE_PROJECT_SUBJECTS]
}

/** `projectId -> acl`, read in two queries rather than one pair per issue. */
export async function projectSearchAcls(
  tx: Tx,
  workspaceId: string,
  projectIds?: readonly string[],
): Promise<Map<string, string[]>> {
  if (projectIds && !projectIds.length) return new Map()
  const projectFilters = [eq(projects.workspaceId, workspaceId)]
  if (projectIds) projectFilters.push(inArray(projects.id, [...projectIds]))
  const rows = await tx
    .select({ id: projects.id, visibility: projects.visibility })
    .from(projects)
    .where(and(...projectFilters))

  const memberFilters = [eq(projectMembers.workspaceId, workspaceId)]
  if (projectIds) memberFilters.push(inArray(projectMembers.projectId, [...projectIds]))
  const members = await tx
    .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(...memberFilters))

  const byProject = new Map<string, string[]>()
  for (const m of members) byProject.set(m.projectId, [...(byProject.get(m.projectId) ?? []), m.userId])
  return new Map(rows.map((r) => [r.id, issueSearchAcl(r.visibility, byProject.get(r.id) ?? [])]))
}

/** The acl for one project, for the paths that only ever touch one. */
export async function issueSearchAclFor(
  tx: Tx,
  workspaceId: string,
  projectId: string,
): Promise<string[] | null> {
  const acls = await projectSearchAcls(tx, workspaceId, [projectId])
  return acls.get(projectId) ?? null
}

/** Keys of the workspace's custom fields marked `searchable`. */
export async function searchableKeys(tx: Tx, workspaceId: string): Promise<ReadonlySet<string>> {
  const rows = await tx
    .select({ key: fieldDefs.key })
    .from(fieldDefs)
    .where(
      and(
        eq(fieldDefs.workspaceId, workspaceId),
        eq(fieldDefs.searchable, true),
        isNull(fieldDefs.archivedAt),
      ),
    )
  return new Set(rows.map((r) => r.key))
}

/**
 * Text from the custom fields marked `searchable`, appended to the indexed body.
 *
 * `searchable` has been settable since the field editor existed and reached nothing, so a workspace
 * that marked "Customer" searchable could not find an issue by customer name.
 */
function searchableText(custom: unknown, keys: ReadonlySet<string>): string {
  if (!keys.size) return ''
  const values = (custom as Record<string, unknown> | null) ?? {}
  const parts: string[] = []
  for (const key of keys) {
    const value = values[key]
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) parts.push(value.filter((v) => typeof v === 'string').join(' '))
    else if (typeof value === 'string' || typeof value === 'number') parts.push(String(value))
  }
  return parts.filter(Boolean).join(' ')
}

/**
 * The fields a search document needs, satisfied by both the drizzle row and the contract `Issue`.
 *
 * There used to be two builders — one here for the indexer, one inline in `IssueService.reindex` —
 * and they had already drifted: only the indexer appended searchable custom-field text, so an issue
 * found by customer name stopped being findable the moment anybody edited it.
 */
export interface IndexableIssue {
  id: string
  key: string
  title: string
  descriptionText: string | null
  projectId: string
  statusId: string
  statusCategory: string
  priority: string
  assigneeIds: readonly string[] | null
  custom: unknown
  updatedAt: Date | string
}

export function issueSearchDocument(
  workspaceId: string,
  row: IndexableIssue,
  opts: { acl: string[] | null; searchableKeys?: ReadonlySet<string> },
): core.SearchDocument {
  const extra = searchableText(row.custom, opts.searchableKeys ?? new Set())
  return {
    workspaceId: workspaceId as core.SearchDocument['workspaceId'],
    object: objectRef('issue', row.id),
    title: `${row.key} ${row.title}`,
    body: [row.descriptionText || '', extra].filter(Boolean).join('\n') || null,
    url: issueUrl(row.key),
    icon: 'square-check-big',
    acl: opts.acl,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : row.updatedAt.toISOString(),
    attributes: {
      projectId: row.projectId,
      statusId: row.statusId,
      statusCategory: row.statusCategory,
      priority: row.priority,
      assigneeIds: row.assigneeIds ?? [],
    },
  }
}

/**
 * Every non-archived issue in one project, as search documents, with the project's acl read once.
 *
 * This is what a readership change re-indexes through. It takes a `Tx` rather than a `Kernel`
 * because every caller is a mutation that has just changed the membership or the visibility inside
 * its own transaction — reading the acl on a fresh connection would read the state before it.
 */
export async function* projectIssueDocuments(
  tx: Tx,
  workspaceId: string,
  projectId: string,
): AsyncGenerator<core.SearchDocument> {
  const acl = (await issueSearchAclFor(tx, workspaceId, projectId)) ?? []
  const keys = await searchableKeys(tx, workspaceId)
  let cursor: string | null = null
  for (;;) {
    const rows: Array<typeof issues.$inferSelect> = await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          eq(issues.projectId, projectId),
          isNull(issues.archivedAt),
          cursor ? sql`${issues.id} > ${cursor}` : sql`true`,
        ),
      )
      .orderBy(issues.id)
      .limit(500)
    if (!rows.length) return
    for (const row of rows) yield issueSearchDocument(workspaceId, row, { acl, searchableKeys: keys })
    cursor = rows.at(-1)?.id ?? null
  }
}

/**
 * Every non-archived issue in a workspace, as search documents.
 *
 * Shared by the module's `scan` indexer and by the acl sweep job, so the two cannot disagree about
 * what a tracker document looks like.
 */
export async function* scanIssueDocuments(
  kernel: Kernel,
  workspaceId: string,
): AsyncGenerator<core.SearchDocument> {
  // read once for the whole scan rather than per row
  const { keys, acls } = await kernel.database.withWorkspace(workspaceId, async (tx) => ({
    keys: await searchableKeys(tx, workspaceId),
    acls: await projectSearchAcls(tx, workspaceId),
  }))
  let cursor: string | null = null
  for (;;) {
    const rows: Array<typeof issues.$inferSelect> = await kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.workspaceId, workspaceId),
            isNull(issues.archivedAt),
            cursor ? sql`${issues.id} > ${cursor}` : sql`true`,
          ),
        )
        .orderBy(issues.id)
        .limit(500),
    )
    if (!rows.length) return
    for (const row of rows)
      yield issueSearchDocument(workspaceId, row, {
        acl: acls.get(row.projectId) ?? [],
        searchableKeys: keys,
      })
    cursor = rows.at(-1)?.id ?? null
  }
}
