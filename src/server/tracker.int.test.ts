import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, KernError, type Kernel, type Tx } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CreateIssue, Issue, IssueQueryInput } from '../contract/models.js'
import * as models from '../contract/models.js'
import { trackerModule } from './index.js'
import { issues } from './schema.js'
import { type TrackerServices, trackerServices } from './services/index.js'

/**
 * Integration coverage against a real Postgres. Every test runs against a scratch database that is
 * created in `beforeAll` and dropped afterwards, so it never touches the development data.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_tracker_test_${Date.now().toString(36)}`
const RLS_ROLE = `kern_tracker_rls_${Date.now().toString(36)}`

let kernel: Kernel
let svc: TrackerServices
let admin: pg.Client
let databaseUrl: string

const WS_A = randomUUID()
const WS_B = randomUUID()
const REVIEWERS_GROUP = randomUUID()
const REVIEWER_ROLE = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()
const CAROL = randomUUID()

const principal = (
  userId: string,
  workspaceId: string,
  role: 'owner' | 'admin' | 'member' | 'guest' = 'admin',
): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId, role, roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const alice = () => principal(ALICE, WS_A)
const bob = () => principal(BOB, WS_A, 'member')
const guest = () => principal(CAROL, WS_A, 'guest')

const inWs =
  (workspaceId: string, actor?: Principal) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: actor?.userId ?? null })

const run = <T>(fn: (tx: Tx) => Promise<T>) => inWs(WS_A, alice())(fn)

/** Stubs for the core procedures the tracker calls out to. */
function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'files.get': {
      handler: async (input: { id: string }) => ({
        id: input.id,
        name: 'attachment.txt',
        mimeType: 'text/plain',
        size: 12,
        key: `test/${input.id}`,
        workspaceId: WS_A,
      }),
    },
    'workspaces.members': {
      // core answers with each member's groups and roles, which is how the tracker expands an
      // approval addressed to a group without a call of its own
      handler: async () => [
        {
          userId: ALICE,
          email: 'alice@example.test',
          name: 'Alice',
          role: 'admin',
          roleIds: [],
          groupIds: [],
        },
        {
          userId: BOB,
          email: 'bob@example.test',
          name: 'Bob',
          role: 'member',
          roleIds: [REVIEWER_ROLE],
          groupIds: [REVIEWERS_GROUP],
        },
      ],
    },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': {
      handler: async (input: { userId: string }) => principal(input.userId, WS_A),
    },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({}) },
  })
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'tracker-test',
    modules: [trackerModule],
    role: 'api',
    env: {
      DATABASE_URL: databaseUrl,
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerCoreStubs(kernel)
  await kernel.start()
  svc = trackerServices(kernel)
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

// =====================================================================================

describe('migrations', () => {
  it('creates the module schema with row level security on every tenant table', async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const tables = await client.query<{ tablename: string; rowsecurity: boolean }>(
        `select tablename, rowsecurity from pg_tables where schemaname = 'mod_tracker' order by tablename`,
      )
      expect(tables.rows.length).toBeGreaterThan(30)
      const unprotected = tables.rows
        .filter((r) => !r.rowsecurity)
        .map((r) => r.tablename)
        .sort()
      // `workspaces` and `intake_tokens` are routing tables that must be readable without a tenant;
      // `__migrations` is drizzle's own bookkeeping
      expect(unprotected).toEqual(['__migrations', 'intake_tokens', 'workspaces'])
      const policies = await client.query(
        `select count(*)::int as n from pg_policies where schemaname = 'mod_tracker'`,
      )
      expect(policies.rows[0].n).toBe(tables.rows.length - unprotected.length)
    } finally {
      await client.end()
    }
  })
})

describe('projects', () => {
  let projectId: string

  it('creates a project seeded from the software template', async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'krn',
        name: 'Kern',
        template: 'software',
        visibility: 'workspace',
        defaultAssignee: 'unassigned',
        memberIds: [BOB],
      } as never),
    )
    projectId = project.id
    expect(project.key).toBe('KRN')
    expect(project.issueCounter).toBe(0)
    expect(project.memberCount).toBe(2)

    const types = await run((tx) => svc.config.listTypes(tx, WS_A, { projectId }))
    expect(types.map((t) => t.key).sort()).toEqual(['bug', 'epic', 'story', 'sub_task', 'task'])
    expect(types.find((t) => t.isDefault)?.key).toBe('story')

    const statuses = await run((tx) => svc.config.statusesForProject(tx, WS_A, projectId))
    expect(statuses.map((s) => s.id)).toEqual([
      'triage',
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'done',
      'cancelled',
    ])

    const views = await run((tx) => svc.views.list(tx, alice(), WS_A, projectId))
    expect(views.filter((v) => v.builtin).length).toBe(4)
  })

  it('refuses a duplicate project key', async () => {
    await expect(
      run((tx) => svc.projects.create(tx, alice(), WS_A, { key: 'KRN', name: 'Clash' } as never)),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('hides a private project from non-members', async () => {
    const secret = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'SEC',
        name: 'Secret',
        template: 'simple',
        visibility: 'private',
        memberIds: [],
      } as never),
    )
    const visibleToBob = await inWs(WS_A, bob())((tx) => svc.access.visibleProjectIds(tx, bob(), WS_A))
    expect(visibleToBob).not.toContain(secret.id)
    expect(visibleToBob).toContain(projectId)
    await expect(
      inWs(WS_A, bob())((tx) => svc.projects.get(tx, bob(), WS_A, secret.id)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

// =====================================================================================

describe('issues', () => {
  let projectId: string
  let storyTypeId: string
  let subTaskTypeId: string
  let first: Issue
  let second: Issue

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'ISS',
        name: 'Issues',
        template: 'software',
        memberIds: [BOB],
      } as never),
    )
    projectId = project.id
    const types = await run((tx) => svc.config.listTypes(tx, WS_A, { projectId }))
    storyTypeId = types.find((t) => t.key === 'story')!.id
    subTaskTypeId = types.find((t) => t.key === 'sub_task')!.id
  })

  it('allocates sequential keys and starts in the workflow initial status', async () => {
    first = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId, title: 'First issue' } as CreateIssue),
    )
    second = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Second issue',
        priority: 'high',
        assigneeIds: [BOB],
      } as never),
    )
    expect(first.key).toBe('ISS-1')
    expect(second.key).toBe('ISS-2')
    expect(first.number).toBe(1)
    expect(first.statusId).toBe('backlog')
    expect(first.statusCategory).toBe('backlog')
    expect(first.typeId).toBe(storyTypeId)
    expect(first.estimateUnit).toBe('points')
    // the creator watches what they create
    expect(first.watcherIds).toContain(ALICE)
    expect(second.watcherIds).toEqual(expect.arrayContaining([ALICE, BOB]))
  })

  it('allocates keys without gaps under concurrent creation', async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run((tx) => svc.issues.create(tx, alice(), WS_A, { projectId, title: `Parallel ${i}` } as never)),
      ),
    )
    const numbers = created.map((i) => i.number).sort((a, b) => a - b)
    expect(new Set(numbers).size).toBe(8)
    expect(numbers).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('ranks new issues after the existing ones and reorders on demand', async () => {
    expect(first.rank < second.rank).toBe(true)
    const moved = await run((tx) => svc.issues.rank(tx, alice(), WS_A, second.id, null, first.id))
    expect(moved.rank < first.rank).toBe(true)
  })

  it('records field changes in the history', async () => {
    const updated = await run((tx) =>
      svc.issues.update(tx, alice(), WS_A, first.id, {
        title: 'First issue (renamed)',
        priority: 'urgent',
        dueDate: '2026-12-24',
      }),
    )
    expect(updated.title).toBe('First issue (renamed)')
    const history = await run((tx) => svc.issues.history(tx, alice(), WS_A, first.id, 50))
    const update = history.items.find((h) => h.action === 'updated')
    expect(update).toBeTruthy()
    expect(update!.changes.map((c) => c.field).sort()).toEqual(['dueDate', 'priority', 'title'])
    expect(update!.changes.find((c) => c.field === 'priority')).toMatchObject({
      from: 'none',
      to: 'urgent',
    })
    expect(history.statusHistory).toHaveLength(1)
    expect(history.statusHistory[0]).toMatchObject({ fromStatusId: null, toStatusId: 'backlog' })
  })

  it('adds new assignees as watchers and skips a no-op update', async () => {
    const before = await run((tx) => svc.issues.get(tx, alice(), WS_A, first.id))
    const same = await run((tx) => svc.issues.update(tx, alice(), WS_A, first.id, {}))
    expect(same.updatedAt).toBe(before.updatedAt)
    const assigned = await run((tx) => svc.issues.update(tx, alice(), WS_A, first.id, { assigneeAdd: [BOB] }))
    expect(assigned.assigneeIds).toContain(BOB)
    expect(assigned.watcherIds).toContain(BOB)
  })

  it('merges custom values and removes a key when the value is null', async () => {
    await run((tx) => svc.config.createField(tx, WS_A, { key: 'severity', name: 'Severity', type: 'text' }))
    await run((tx) => svc.config.createField(tx, WS_A, { key: 'extra', name: 'Extra', type: 'number' }))
    const withValue = await run((tx) =>
      svc.issues.update(tx, alice(), WS_A, first.id, { custom: { severity: 'sev1', extra: 1 } }),
    )
    expect(withValue.custom).toMatchObject({ severity: 'sev1', extra: 1 })
    const cleared = await run((tx) =>
      svc.issues.update(tx, alice(), WS_A, first.id, { custom: { severity: null } }),
    )
    expect(cleared.custom.severity).toBeUndefined()
    expect(cleared.custom.extra).toBe(1)
  })

  it('refuses a custom key that no field defines', async () => {
    // A key with no definition used to be stored as written, so `serverity` looked like a field
    // that would not save. It is now an error naming the key.
    await expect(
      run((tx) => svc.issues.update(tx, alice(), WS_A, first.id, { custom: { serverity: 'sev1' } })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('validates a custom value on update, not only on create', async () => {
    await run((tx) =>
      svc.config.createField(tx, WS_A, {
        key: 'impact_level',
        name: 'Impact level',
        type: 'select',
        options: [{ id: 'high', label: 'High', color: null, order: 0, archived: false }],
      } as never),
    )
    await expect(
      run((tx) => svc.issues.update(tx, alice(), WS_A, first.id, { custom: { impact_level: 'nonsense' } })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const ok = await run((tx) =>
      svc.issues.update(tx, alice(), WS_A, first.id, { custom: { impact_level: 'high' } }),
    )
    expect(ok.custom.impact_level).toBe('high')
  })

  it('keeps sub-item hierarchy rules', async () => {
    const child = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'A sub task',
        typeId: subTaskTypeId,
        parentId: first.id,
      } as never),
    )
    expect(child.parentId).toBe(first.id)
    const parent = await run((tx) => svc.issues.get(tx, alice(), WS_A, first.id))
    expect(parent.relationSummary.subItems).toBe(1)
    expect(parent.relationSummary.subItemsDone).toBe(0)

    // a story may not be parented by a sub-task: the child would sit above its parent
    await expect(
      run((tx) =>
        svc.issues.create(tx, alice(), WS_A, {
          projectId,
          title: 'Inverted',
          typeId: storyTypeId,
          parentId: child.id,
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('creates a relation in both directions and counts open blockers', async () => {
    const relations = await run((tx) =>
      svc.issues.createRelation(tx, alice(), WS_A, first.id, 'blocked_by', second.id),
    )
    expect(relations).toHaveLength(1)
    expect(relations[0]).toMatchObject({ type: 'blocked_by' })

    const mirrored = await run((tx) => svc.issues.listRelations(tx, alice(), WS_A, second.id))
    expect(mirrored[0]).toMatchObject({ type: 'blocks' })

    const blocked = await run((tx) => svc.issues.get(tx, alice(), WS_A, first.id))
    expect(blocked.relationSummary.blockedBy).toBe(1)
    expect(blocked.relationSummary.openBlockers).toBe(1)

    await run((tx) => svc.issues.deleteRelation(tx, alice(), WS_A, relations[0]!.id))
    expect(await run((tx) => svc.issues.listRelations(tx, alice(), WS_A, second.id))).toHaveLength(0)
  })

  it('reports per-issue outcomes from a bulk update', async () => {
    const result = await svc.issues.bulkUpdate(alice(), WS_A, [first.id, randomUUID()], {
      priority: 'low',
    })
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.results[1]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('refuses to delete an issue without the permission', async () => {
    await expect(
      inWs(WS_A, guest())((tx) => svc.issues.delete(tx, guest(), WS_A, second.id)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('archives and restores an issue', async () => {
    const archived = await run((tx) => svc.issues.archive(tx, alice(), WS_A, second.id, true))
    expect(archived.archivedAt).toBeTruthy()
    const restored = await run((tx) => svc.issues.archive(tx, alice(), WS_A, second.id, false))
    expect(restored.archivedAt).toBeNull()
  })
})

// =====================================================================================

describe('transitions', () => {
  let projectId: string
  let issue: Issue
  let subTaskTypeId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'FLW', name: 'Flow', template: 'software' } as never),
    )
    projectId = project.id
    const types = await run((tx) => svc.config.listTypes(tx, WS_A, { projectId }))
    subTaskTypeId = types.find((t) => t.key === 'sub_task')!.id
    issue = await run((tx) => svc.issues.create(tx, alice(), WS_A, { projectId, title: 'Flowing' } as never))
  })

  it('lists the transitions available from the current status', async () => {
    const available = await run((tx) => svc.transitions.available(tx, alice(), WS_A, issue.id))
    const byId = new Map(available.map((t) => [t.id, t]))
    expect([...byId.keys()].sort()).toEqual(['cancel', 'plan', 'start'])
    expect(byId.get('plan')).toMatchObject({ allowed: true, toStatusId: 'todo' })
    expect(byId.get('plan')!.toStatus).toMatchObject({ name: 'Todo', category: 'todo' })
  })

  it('applies a transition, writes status history and assigns via a post-function', async () => {
    const planned = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, issue.id, { transitionId: 'plan' }),
    )
    expect(planned.issue.statusId).toBe('todo')
    expect(planned.approval).toBeNull()

    const started = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, issue.id, { transitionId: 'start' }),
    )
    // the software template assigns the actor when work starts
    expect(started.issue.assigneeIds).toEqual([ALICE])
    expect(started.issue.statusCategory).toBe('in_progress')

    const history = await run((tx) => svc.issues.history(tx, alice(), WS_A, issue.id, 50))
    expect(history.statusHistory.map((h) => h.toStatusId)).toEqual(['backlog', 'todo', 'in_progress'])
    expect(history.statusHistory[2]).toMatchObject({ fromStatusId: 'todo', transitionId: 'start' })
    expect(history.statusHistory[2]!.durationSec).not.toBeNull()
  })

  it('blocks a transition whose condition fails and allows it once satisfied', async () => {
    const child = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Blocking sub task',
        typeId: subTaskTypeId,
        parentId: issue.id,
      } as never),
    )
    const blocked = await run((tx) => svc.transitions.available(tx, alice(), WS_A, issue.id))
    const complete = blocked.find((t) => t.id === 'complete')!
    expect(complete.allowed).toBe(false)
    expect(complete.reasons[0]!.message).toContain('sub-items')
    await expect(
      run((tx) => svc.transitions.apply(tx, alice(), WS_A, issue.id, { transitionId: 'complete' })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    await run((tx) => svc.transitions.moveToStatus(tx, alice(), WS_A, child.id, 'done'))
    const done = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, issue.id, { transitionId: 'complete' }),
    )
    expect(done.issue.statusId).toBe('done')
    expect(done.issue.resolution).toBe('done')
    expect(done.issue.completedAt).toBeTruthy()
  })

  it('rejects a validator failure with the field that caused it', async () => {
    const triaged = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId, title: 'Needs triage' } as never),
    )
    await run((tx) => svc.transitions.moveToStatus(tx, alice(), WS_A, triaged.id, 'triage'))
    // the software template's `decline` transition requires a comment
    await expect(
      run((tx) => svc.transitions.apply(tx, alice(), WS_A, triaged.id, { transitionId: 'decline' })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const declined = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, triaged.id, {
        transitionId: 'decline',
        comment: 'Not something we will do.',
      }),
    )
    expect(declined.issue.statusCategory).toBe('cancelled')
    expect(declined.issue.cancelledAt).toBeTruthy()
    const comments = await run((tx) => svc.comments.list(tx, alice(), WS_A, triaged.id, 10))
    expect(comments.items.at(-1)?.bodyText).toBe('Not something we will do.')
  })

  it('parks a transition that needs approval and applies it once approved', async () => {
    const workflow = await run((tx) =>
      svc.config.createWorkflow(tx, WS_A, {
        projectId,
        name: 'Approval flow',
        definition: {
          id: 'approval',
          name: 'Approval flow',
          statuses: [
            { id: 'open', name: 'Open', category: 'todo', order: 0, initial: true },
            { id: 'shipped', name: 'Shipped', category: 'done', order: 1 },
          ],
          transitions: [
            {
              id: 'ship',
              name: 'Ship',
              from: ['open'],
              to: 'shipped',
              approval: { approvers: [{ kind: 'user', id: BOB }], minApprovals: 1 },
            },
          ],
        } as never,
      }),
    )
    const type = await run((tx) =>
      svc.config.createType(
        tx,
        WS_A,
        {
          projectId,
          key: 'release',
          name: 'Release',
          level: 0,
          workflowId: workflow.id,
        } as never,
        ALICE,
      ),
    )
    const release = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Ship 1.0',
        typeId: type.id,
      } as never),
    )
    const parked = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, release.id, { transitionId: 'ship' }),
    )
    expect(parked.approval).toBeTruthy()
    expect(parked.issue.statusId).toBe('open')

    await expect(
      run((tx) => svc.transitions.decide(tx, alice(), WS_A, release.id, 'ship', 'approve')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const decided = await inWs(
      WS_A,
      bob(),
    )((tx) => svc.transitions.decide(tx, bob(), WS_A, release.id, 'ship', 'approve'))
    expect(decided.approval.state.status).toBe('approved')
    expect(decided.issue?.statusId).toBe('shipped')
  })
})

// =====================================================================================

describe('KQL queries', () => {
  let projectId: string
  let bugLabelId: string
  const query = (input: Partial<IssueQueryInput>) =>
    run((tx) =>
      svc.query.query(tx, alice(), {
        workspaceId: WS_A as IssueQueryInput['workspaceId'],
        kql: '',
        limit: 100,
        includeArchived: false,
        include: { total: false, groupCounts: false, full: false },
        ...input,
      } as IssueQueryInput),
    )

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'KQL', name: 'Query', template: 'software' } as never),
    )
    projectId = project.id
    const label = await run((tx) =>
      svc.planning.createLabel(tx, alice(), WS_A, { projectId, name: 'regression' }),
    )
    bugLabelId = label.id
    await run((tx) =>
      svc.config.createField(tx, WS_A, {
        projectId,
        key: 'story_points',
        name: 'Story points',
        type: 'number',
      }),
    )

    const seed: Array<Partial<CreateIssue>> = [
      { title: 'Urgent crash on boot', priority: 'urgent', assigneeIds: [ALICE as never], estimate: 5 },
      { title: 'Slow search', priority: 'medium', assigneeIds: [BOB as never], estimate: 3 },
      { title: 'Typo in footer', priority: 'low', labelIds: [bugLabelId], estimate: 1 },
      { title: 'Flaky regression test', priority: 'high', labelIds: [bugLabelId], dueDate: '2026-01-15' },
      { title: 'Backlog grooming', priority: 'none', custom: { story_points: 8 } },
    ]
    for (const values of seed)
      await run((tx) => svc.issues.create(tx, alice(), WS_A, { projectId, ...values } as CreateIssue))
  })

  it('returns everything for an empty query', async () => {
    const result = await query({
      projectIds: [projectId],
      include: { total: true, groupCounts: false, full: true },
    })
    expect(result.items).toHaveLength(5)
    expect(result.total).toBe(5)
    // the contract promises full issues, not summaries
    expect(result.items[0]).toHaveProperty('relationSummary')
    expect(result.items[0]).toHaveProperty('descriptionText')
  })

  it('filters on an enum with = and in', async () => {
    expect((await query({ kql: 'priority = urgent', projectIds: [projectId] })).items).toHaveLength(1)
    expect((await query({ kql: 'priority in (high, urgent)', projectIds: [projectId] })).items).toHaveLength(
      2,
    )
    expect(
      (await query({ kql: 'priority not in (high, urgent)', projectIds: [projectId] })).items,
    ).toHaveLength(3)
  })

  it('orders priority by severity, not alphabetically', async () => {
    const result = await query({ kql: 'priority > medium', projectIds: [projectId] })
    expect(result.items.map((i) => i.priority).sort()).toEqual(['high', 'urgent'])
  })

  it('resolves currentUser() and array membership for assignees', async () => {
    const mine = await query({ kql: 'assignee = currentUser()', projectIds: [projectId] })
    expect(mine.items.map((i) => i.title)).toEqual(['Urgent crash on boot'])
    const unassigned = await query({ kql: 'assignee is empty', projectIds: [projectId] })
    expect(unassigned.items).toHaveLength(3)
  })

  it('resolves label names to ids', async () => {
    const result = await query({ kql: 'label = regression', projectIds: [projectId] })
    expect(result.items).toHaveLength(2)
    expect((await query({ kql: 'label = nosuchlabel', projectIds: [projectId] })).items).toHaveLength(0)
  })

  it('matches free text through the generated tsvector', async () => {
    expect((await query({ kql: 'text ~ crash', projectIds: [projectId] })).items).toHaveLength(1)
    expect((await query({ kql: 'title ~ "in footer"', projectIds: [projectId] })).items).toHaveLength(1)
  })

  it('compares dates, relative dates and functions', async () => {
    expect((await query({ kql: 'due < 2026-06-01', projectIds: [projectId] })).items).toHaveLength(1)
    expect((await query({ kql: 'created > -1d', projectIds: [projectId] })).items).toHaveLength(5)
    expect((await query({ kql: 'created > startOfDay(1)', projectIds: [projectId] })).items).toHaveLength(0)
    expect((await query({ kql: 'due is not empty', projectIds: [projectId] })).items).toHaveLength(1)
  })

  it('compares numbers and custom fields', async () => {
    expect((await query({ kql: 'estimate >= 3', projectIds: [projectId] })).items).toHaveLength(2)
    expect((await query({ kql: 'cf.story_points = 8', projectIds: [projectId] })).items).toHaveLength(1)
    expect((await query({ kql: 'cf.story_points > 10', projectIds: [projectId] })).items).toHaveLength(0)
  })

  it('combines terms with and / or / not and parentheses', async () => {
    const combined = await query({
      kql: '(priority = urgent or priority = high) and assignee is empty',
      projectIds: [projectId],
    })
    expect(combined.items.map((i) => i.title)).toEqual(['Flaky regression test'])
    const negated = await query({ kql: 'not priority = none', projectIds: [projectId] })
    expect(negated.items).toHaveLength(4)
  })

  it('sorts by an explicit order by clause', async () => {
    const result = await query({ kql: 'order by priority desc', projectIds: [projectId] })
    expect(result.items.map((i) => i.priority)).toEqual(['urgent', 'high', 'medium', 'low', 'none'])
  })

  it('paginates with a cursor', async () => {
    const firstPage = await query({ projectIds: [projectId], limit: 2, kql: 'order by created' })
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.nextCursor).toBeTruthy()
    const secondPage = await query({
      projectIds: [projectId],
      limit: 2,
      kql: 'order by created',
      cursor: firstPage.nextCursor!,
    })
    expect(secondPage.items).toHaveLength(2)
    expect(secondPage.items.map((i) => i.id)).not.toEqual(firstPage.items.map((i) => i.id))
  })

  it('returns per-group counts', async () => {
    const grouped = await query({
      projectIds: [projectId],
      groupBy: 'priority',
      include: { total: false, groupCounts: true, full: false },
    })
    expect(grouped.groups).toBeTruthy()
    const counts = Object.fromEntries(grouped.groups!.map((g) => [g.key, g.count]))
    expect(counts).toMatchObject({ urgent: 1, high: 1, medium: 1, low: 1, none: 1 })
    const byAssignee = await query({
      projectIds: [projectId],
      groupBy: 'assignee',
      include: { total: false, groupCounts: true, full: false },
    })
    expect(byAssignee.groups!.map((g) => g.key).sort()).toEqual([ALICE, BOB].sort())
  })

  it('reports the fields a query used and rejects an invalid one', async () => {
    const result = await query({ kql: 'priority = high and label = regression', projectIds: [projectId] })
    expect(result.fields.sort()).toEqual(['label', 'priority'])
    await expect(query({ kql: 'nope = 1', projectIds: [projectId] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(query({ kql: 'priority =', projectIds: [projectId] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('never returns issues from a project the caller cannot see', async () => {
    const hidden = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'HID',
        name: 'Hidden',
        template: 'simple',
        visibility: 'private',
      } as never),
    )
    await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId: hidden.id, title: 'Confidential' } as never),
    )
    const asBob = await inWs(
      WS_A,
      bob(),
    )((tx) =>
      svc.query.query(tx, bob(), {
        workspaceId: WS_A as IssueQueryInput['workspaceId'],
        kql: 'text ~ Confidential',
        limit: 50,
        includeArchived: false,
        include: { total: false, groupCounts: false, full: false },
      } as IssueQueryInput),
    )
    expect(asBob.items).toHaveLength(0)
  })

  it('parses and normalises a query through the API surface', async () => {
    const parsed = await run((tx) => svc.query.parse(tx, alice(), WS_A, 'priority=high AND label=regression'))
    expect(parsed.ok).toBe(true)
    expect(parsed.normalized).toBe('priority = high and label = regression')
    const broken = await run((tx) => svc.query.parse(tx, alice(), WS_A, 'priority ='))
    expect(broken.ok).toBe(false)
    expect(broken.errors).not.toHaveLength(0)
    expect(broken.suggestions.length).toBeGreaterThan(0)
  })

  it('describes the available fields including custom ones', async () => {
    const fields = await run((tx) => svc.query.fieldInfo(tx, alice(), WS_A, [projectId]))
    const names = fields.map((f) => f.name)
    expect(names).toContain('priority')
    expect(names).toContain('cf.story_points')
    expect(fields.find((f) => f.name === 'priority')!.values?.map((v) => v.value)).toContain('urgent')
    expect(fields.find((f) => f.name === 'status')!.values?.length).toBeGreaterThan(0)
  })
})

// =====================================================================================

describe('planning', () => {
  let projectId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'PLN', name: 'Planning', template: 'kanban' } as never),
    )
    projectId = project.id
  })

  it('runs a cycle from creation through completion with carry-over', async () => {
    const now = Date.now()
    const cycle = await run((tx) =>
      svc.planning.createCycle(tx, alice(), WS_A, projectId, {
        name: 'Cycle 1',
        startAt: new Date(now - 86_400_000).toISOString(),
        endAt: new Date(now + 86_400_000).toISOString(),
      }),
    )
    expect(cycle.number).toBe(1)
    const next = await run((tx) =>
      svc.planning.createCycle(tx, alice(), WS_A, projectId, {
        startAt: new Date(now + 86_400_000).toISOString(),
        endAt: new Date(now + 3 * 86_400_000).toISOString(),
      }),
    )
    expect(next.number).toBe(2)
    expect(next.name).toBe('Cycle 2')

    const done = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Finished work',
        cycleId: cycle.id,
        estimate: 3,
      } as never),
    )
    const open = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Unfinished work',
        cycleId: cycle.id,
        estimate: 5,
      } as never),
    )

    const started = await run((tx) => svc.planning.startCycle(tx, alice(), WS_A, cycle.id))
    expect(started.status).toBe('active')
    expect(started.stats).toMatchObject({ total: 2, estimateTotal: 8 })

    await expect(run((tx) => svc.planning.startCycle(tx, alice(), WS_A, next.id))).rejects.toMatchObject({
      code: 'CONFLICT',
    })

    await run((tx) => svc.transitions.moveToStatus(tx, alice(), WS_A, done.id, 'done'))
    const completed = await run((tx) => svc.planning.completeCycle(tx, alice(), WS_A, cycle.id))
    expect(completed.status).toBe('completed')

    const rolled = await run((tx) => svc.issues.get(tx, alice(), WS_A, open.id))
    expect(rolled.cycleId).toBe(next.id)
    const nextCycle = await run((tx) => svc.planning.getCycle(tx, alice(), WS_A, next.id))
    expect(nextCycle.carryOverCount).toBe(1)
  })

  it('counts issues per milestone, version, component and label', async () => {
    const milestone = await run((tx) =>
      svc.planning.createMilestone(tx, alice(), WS_A, projectId, { name: 'Launch' }),
    )
    const version = await run((tx) =>
      svc.planning.createVersion(tx, alice(), WS_A, projectId, { name: '1.0' }),
    )
    const component = await run((tx) =>
      svc.planning.createComponent(tx, alice(), WS_A, projectId, { name: 'API' }),
    )
    const label = await run((tx) => svc.planning.createLabel(tx, alice(), WS_A, { projectId, name: 'chore' }))
    await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Tagged everywhere',
        milestoneId: milestone.id,
        versionIds: [version.id],
        componentIds: [component.id],
        labelIds: [label.id],
      } as never),
    )
    expect((await run((tx) => svc.planning.listMilestones(tx, alice(), WS_A, projectId)))[0]!.stats).toEqual({
      total: 1,
      done: 0,
    })
    expect((await run((tx) => svc.planning.listVersions(tx, alice(), WS_A, projectId)))[0]!.stats).toEqual({
      total: 1,
      done: 0,
    })
    expect(
      (await run((tx) => svc.planning.listComponents(tx, alice(), WS_A, projectId)))[0]!.issueCount,
    ).toBe(1)
    expect(
      (await run((tx) => svc.planning.listLabels(tx, alice(), WS_A, projectId))).find(
        (l) => l.name === 'chore',
      )!.issueCount,
    ).toBe(1)
  })

  it('keeps labels in a group mutually exclusive', async () => {
    const red = await run((tx) =>
      svc.planning.createLabel(tx, alice(), WS_A, { projectId, name: 'red', groupName: 'colour' }),
    )
    const blue = await run((tx) =>
      svc.planning.createLabel(tx, alice(), WS_A, { projectId, name: 'blue', groupName: 'colour' }),
    )
    const issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Only one colour',
        labelIds: [red.id, blue.id],
      } as never),
    )
    expect(issue.labelIds).toEqual([blue.id])
  })

  it('releases a version', async () => {
    const version = await run((tx) =>
      svc.planning.createVersion(tx, alice(), WS_A, projectId, { name: '2.0' }),
    )
    const released = await run((tx) => svc.planning.releaseVersion(tx, alice(), WS_A, version.id, true))
    expect(released.status).toBe('released')
    expect(released.releasedAt).toBeTruthy()
  })
})

// =====================================================================================

describe('comments, time tracking and views', () => {
  let projectId: string
  let issue: Issue

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'CMT', name: 'Comments', template: 'simple' } as never),
    )
    projectId = project.id
    issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Discuss this',
        originalEstimateSec: 3600,
      } as never),
    )
  })

  it('stores comments with mentions and keeps the counter in step', async () => {
    const comment = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, issue.id, {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'ping ' },
              { type: 'mention', attrs: { id: BOB, label: 'bob', kind: 'user' } },
            ],
          },
        ],
      }),
    )
    expect(comment.mentionIds).toEqual([BOB])
    expect(comment.bodyText).toBe('ping @bob')
    const withComment = await run((tx) => svc.issues.get(tx, alice(), WS_A, issue.id))
    expect(withComment.commentCount).toBe(1)
    expect(withComment.watcherIds).toContain(ALICE)
  })

  it('toggles a reaction on and off', async () => {
    const [comment] = (await run((tx) => svc.comments.list(tx, alice(), WS_A, issue.id, 10))).items
    const reacted = await run((tx) => svc.comments.react(tx, bob(), WS_A, comment!.id, '👍'))
    expect(reacted.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [BOB] }])
    const cleared = await run((tx) => svc.comments.react(tx, bob(), WS_A, comment!.id, '👍'))
    expect(cleared.reactions).toEqual([])
  })

  it('soft-deletes a comment and hides its body', async () => {
    const comment = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, issue.id, {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'oops' }] }],
      }),
    )
    await run((tx) => svc.comments.delete(tx, alice(), WS_A, comment.id))
    const listed = await run((tx) => svc.comments.list(tx, alice(), WS_A, issue.id, 10))
    const deleted = listed.items.find((c) => c.id === comment.id)!
    expect(deleted.deletedAt).toBeTruthy()
    expect(deleted.bodyText).toBe('')
  })

  it('logs work and reduces the remaining estimate', async () => {
    const { issue: afterLog, worklog } = await run((tx) =>
      svc.time.create(tx, alice(), WS_A, issue.id, { durationSec: 900, adjustRemaining: 'auto' }),
    )
    expect(worklog.durationSec).toBe(900)
    expect(afterLog.timeSpentSec).toBe(900)
    expect(afterLog.remainingSec).toBe(2700)

    await run((tx) => svc.time.delete(tx, alice(), WS_A, worklog.id))
    const afterDelete = await run((tx) => svc.issues.get(tx, alice(), WS_A, issue.id))
    expect(afterDelete.timeSpentSec).toBe(0)
  })

  it('turns a running timer into a worklog', async () => {
    const timer = await run((tx) => svc.time.start(tx, alice(), WS_A, issue.id, 'focus'))
    expect(timer.issueId).toBe(issue.id)
    expect((await run((tx) => svc.time.current(tx, alice(), WS_A))).timer?.id).toBe(timer.id)
    const stopped = await run((tx) => svc.time.stop(tx, alice(), WS_A, false))
    expect(stopped.worklog?.durationSec).toBeGreaterThan(0)
    expect((await run((tx) => svc.time.current(tx, alice(), WS_A))).timer).toBeNull()
  })

  it('creates, pins and protects views', async () => {
    const view = await run((tx) =>
      svc.views.create(tx, alice(), WS_A, {
        projectId,
        name: 'Urgent work',
        kql: 'priority = urgent',
        layout: 'board',
        visibility: 'project',
      } as never),
    )
    expect(view.display.groupBy).toBe('none')
    await expect(
      run((tx) =>
        svc.views.create(tx, alice(), WS_A, {
          projectId,
          name: 'Broken',
          kql: 'priority =',
          layout: 'list',
          visibility: 'private',
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    const pinned = await run((tx) => svc.views.pin(tx, alice(), WS_A, view.id, true))
    expect(pinned.pinned).toBe(true)
    expect(
      (await run((tx) => svc.views.list(tx, alice(), WS_A, projectId))).find((v) => v.id === view.id),
    ).toMatchObject({ pinned: true })
    // another user does not inherit the pin
    expect(
      (await inWs(WS_A, bob())((tx) => svc.views.list(tx, bob(), WS_A, projectId))).find(
        (v) => v.id === view.id,
      )!.pinned,
    ).toBe(false)

    const builtin = (await run((tx) => svc.views.list(tx, alice(), WS_A, projectId))).find((v) => v.builtin)!
    await expect(run((tx) => svc.views.delete(tx, alice(), WS_A, builtin.id))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('keeps a private view out of the list of another member', async () => {
    const mine = await run((tx) =>
      svc.views.create(tx, alice(), WS_A, {
        projectId,
        name: 'Just mine',
        kql: '',
        layout: 'list',
        visibility: 'private',
      } as never),
    )
    const bobSees = await inWs(WS_A, bob())((tx) => svc.views.list(tx, bob(), WS_A, projectId))
    expect(bobSees.map((v) => v.id)).not.toContain(mine.id)
  })
})

// =====================================================================================

describe('intake, triage and email', () => {
  let projectId: string
  let token: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'INT',
        name: 'Intake',
        template: 'software',
        settings: { triage: { enabled: true } },
      } as never),
    )
    projectId = project.id
    const result = await run((tx) => svc.projects.setIntake(tx, alice(), WS_A, projectId, true, false))
    token = result.token!
  })

  it('serves the public form and creates a triage issue from a submission', async () => {
    const form = await svc.intake.form(token)
    expect(form.projectId).toBe(projectId)
    expect(form.fields.map((f) => f.key)).toContain('email')

    const submitted = await svc.intake.submit({
      token,
      title: 'The export is broken',
      description: 'It fails with a 500.',
      email: 'reporter@example.test',
    })
    expect(submitted.issueKey).toMatch(/^INT-\d+$/)

    const issue = await run((tx) => svc.issues.getByKey(tx, alice(), WS_A, submitted.issueKey))
    expect(issue.triage).toBe(true)
    expect(issue.source).toBe('intake')
    expect(issue.statusId).toBe('triage')
    expect(issue.descriptionText).toContain('reporter@example.test')
  })

  it('rejects a submission that fills the honeypot', async () => {
    await expect(svc.intake.submit({ token, title: 'spam', website: '' as never })).resolves.toBeTruthy()
    await expect(
      svc.intake.submit({ token, title: 'spam', website: 'http://spam' as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses an unknown token', async () => {
    await expect(svc.intake.form('not-a-real-token')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('accepts and snoozes triage items', async () => {
    const submitted = await svc.intake.submit({ token, title: 'Please add dark mode' })
    const issue = await run((tx) => svc.issues.getByKey(tx, alice(), WS_A, submitted.issueKey))
    const snoozed = await run((tx) =>
      svc.intake.snooze(tx, alice(), WS_A, issue.id, new Date(Date.now() - 1000).toISOString()),
    )
    expect(snoozed.snoozedUntil).toBeTruthy()
    expect(await svc.intake.wakeSnoozed(WS_A)).toBeGreaterThan(0)

    const accepted = await run((tx) => svc.intake.accept(tx, alice(), WS_A, issue.id))
    expect(accepted.triage).toBe(false)
    expect(accepted.statusId).toBe('backlog')
  })

  it('creates an issue from an inbound email and threads the reply onto it', async () => {
    const created = await svc.intake.ingestEmail({
      projectToken: token,
      messageId: '<first@mail.test>',
      references: [],
      from: { address: 'customer@example.test', name: 'Customer' },
      to: [],
      subject: 'Cannot log in',
      text: 'It says my password is wrong.',
      attachments: [],
    })
    expect(created.action).toBe('created')
    expect(created.issueKey).toMatch(/^INT-\d+$/)

    const replied = await svc.intake.ingestEmail({
      projectToken: token,
      messageId: '<second@mail.test>',
      inReplyTo: '<first@mail.test>',
      references: ['<first@mail.test>'],
      from: { address: 'customer@example.test' },
      to: [],
      subject: 'Re: Cannot log in',
      text: 'Never mind, it works now.\n\nOn Tue, support wrote:\n> did you reset it',
      attachments: [],
    })
    expect(replied.action).toBe('commented')
    expect(replied.issueId).toBe(created.issueId)

    const comments = await run((tx) => svc.comments.list(tx, alice(), WS_A, created.issueId!, 10))
    expect(comments.items.at(-1)!.bodyText).toBe('Never mind, it works now.')
    expect(comments.items.at(-1)!.source).toBe('email')

    // the same message must not be ingested twice
    const duplicate = await svc.intake.ingestEmail({
      projectToken: token,
      messageId: '<first@mail.test>',
      references: [],
      from: { address: 'customer@example.test' },
      to: [],
      subject: 'Cannot log in',
      text: 'again',
      attachments: [],
    })
    expect(duplicate.action).toBe('ignored')
  })

  it('threads by issue key in the subject when there are no references', async () => {
    const issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId, title: 'Keyed thread' } as never),
    )
    const result = await svc.intake.ingestEmail({
      projectToken: token,
      messageId: '<keyed@mail.test>',
      references: [],
      from: { address: 'customer@example.test' },
      to: [],
      subject: `Re: [${issue.key}] Keyed thread`,
      text: 'more detail',
      attachments: [],
    })
    expect(result).toMatchObject({ action: 'commented', issueId: issue.id })
  })
})

// =====================================================================================

describe('reports', () => {
  let projectId: string
  let cycleId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'RPT', name: 'Reports', template: 'kanban' } as never),
    )
    projectId = project.id
    const now = Date.now()
    const cycle = await run((tx) =>
      svc.planning.createCycle(tx, alice(), WS_A, projectId, {
        name: 'Reporting cycle',
        startAt: new Date(now - 2 * 86_400_000).toISOString(),
        endAt: new Date(now + 2 * 86_400_000).toISOString(),
      }),
    )
    cycleId = cycle.id
    const a = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Done work',
        cycleId,
        estimate: 5,
      } as never),
    )
    await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Open work',
        cycleId,
        estimate: 3,
      } as never),
    )
    await run((tx) => svc.planning.startCycle(tx, alice(), WS_A, cycleId))
    await run((tx) => svc.transitions.moveToStatus(tx, alice(), WS_A, a.id, 'done'))
    await run((tx) =>
      svc.time.create(tx, alice(), WS_A, a.id, {
        durationSec: 1800,
        billable: true,
        adjustRemaining: 'leave',
      }),
    )
  })

  const today = () => new Date().toISOString().slice(0, 10)
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

  it('builds a burndown over the cycle window', async () => {
    const report = await run((tx) => svc.reports.burndown(tx, alice(), WS_A, cycleId))
    expect(report.unit).toBe('points')
    expect(report.points.length).toBeGreaterThanOrEqual(4)
    expect(report.points[0]).toMatchObject({ scope: 0, remaining: 0 })
    const last = report.points.at(-1)!
    expect(last.scope).toBe(8)
    expect(last.completed).toBe(5)
    expect(last.remaining).toBe(3)
    expect(report.cycle.stats).toMatchObject({ total: 2, done: 1 })
  })

  it('reports velocity against the committed snapshot', async () => {
    const report = await run((tx) => svc.reports.velocity(tx, alice(), WS_A, projectId, 6))
    expect(report.cycles).toHaveLength(1)
    expect(report.cycles[0]).toMatchObject({ committed: 8, completed: 5, completedCount: 1 })
    expect(report.average).toBe(5)
  })

  it('builds a cumulative flow diagram from the status history', async () => {
    const report = await run((tx) => svc.reports.cfd(tx, alice(), WS_A, projectId, daysAgo(2), today()))
    expect(report.statuses.map((s) => s.id)).toContain('done')
    const last = report.points.at(-1)!
    expect(last.counts.done).toBe(1)
    expect(last.counts.todo).toBe(1)
  })

  it('counts created against resolved issues per day', async () => {
    const report = await run((tx) =>
      svc.reports.createdVsResolved(tx, alice(), WS_A, projectId, daysAgo(2), today()),
    )
    const last = report.points.at(-1)!
    expect(last.created).toBe(2)
    expect(last.resolved).toBe(1)
    expect(last.openTotal).toBe(1)
  })

  it('aggregates logged time by user and issue', async () => {
    const report = await run((tx) =>
      svc.reports.time(tx, alice(), WS_A, {
        from: daysAgo(1),
        to: today(),
        projectId,
        billableOnly: false,
      }),
    )
    expect(report.totalSec).toBe(1800)
    expect(report.billableSec).toBe(1800)
    expect(report.byUser).toEqual([{ userId: ALICE, durationSec: 1800, billableSec: 1800 }])
    expect(report.byIssue[0]).toMatchObject({ durationSec: 1800 })
    expect(report.rows[0]).toMatchObject({ date: today(), durationSec: 1800 })
  })
})

// =====================================================================================

describe('module procedures and cross-workspace isolation', () => {
  it('exposes issues through kernel.call', async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'RPC', name: 'Rpc', template: 'simple' } as never),
    )
    const created = await kernel.call<Issue>('tracker.issues.create', {
      workspaceId: WS_A,
      issue: { projectId: project.id, title: 'Made over rpc' },
    })
    expect(created.key).toBe('RPC-1')
    expect(created.source).toBe('api')

    const fetched = await kernel.call<Issue>('tracker.issues.get', {
      workspaceId: WS_A,
      issueId: created.id,
    })
    expect(fetched.id).toBe(created.id)

    const members = await kernel.call<{ userIds: string[] }>('tracker.projects.members', {
      workspaceId: WS_A,
      projectId: project.id,
    })
    expect(members.userIds).toContain(ALICE)

    const access = await kernel.call<{ canView: boolean; canEdit: boolean }>('tracker.collab.access', {
      workspaceId: WS_A,
      issueId: created.id,
      userId: ALICE,
    })
    expect(access).toEqual({ canView: true, canEdit: true })
  })

  it('does not leak issues between workspaces at the query layer', async () => {
    const other = principal(ALICE, WS_B)
    const project = await inWs(
      WS_B,
      other,
    )((tx) =>
      svc.projects.create(tx, other, WS_B, { key: 'OTH', name: 'Other', template: 'simple' } as never),
    )
    await inWs(
      WS_B,
      other,
    )((tx) => svc.issues.create(tx, other, WS_B, { projectId: project.id, title: 'Only in B' } as never))
    const fromA = await run((tx) =>
      svc.query.query(tx, alice(), {
        workspaceId: WS_A as IssueQueryInput['workspaceId'],
        kql: 'text ~ "Only in B"',
        limit: 50,
        includeArchived: false,
        include: { total: false, groupCounts: false, full: false },
      } as IssueQueryInput),
    )
    expect(fromA.items).toHaveLength(0)
  })

  it('enforces workspace isolation in the database, not just in the query builder', async () => {
    // the dev role is a superuser and would bypass RLS, so switch to a plain role for this check
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`create role "${RLS_ROLE}" nologin`)
      await client.query(`grant usage on schema mod_tracker to "${RLS_ROLE}"`)
      await client.query(
        `grant select, insert, update, delete on all tables in schema mod_tracker to "${RLS_ROLE}"`,
      )
      await client.query('begin')
      await client.query(`set local role "${RLS_ROLE}"`)

      await client.query(`select set_config('app.workspace_id', $1, true)`, [WS_A])
      const inA = await client.query('select count(*)::int as n from mod_tracker.issues')
      expect(inA.rows[0].n).toBeGreaterThan(0)

      await client.query(`select set_config('app.workspace_id', $1, true)`, [WS_B])
      const inB = await client.query('select count(*)::int as n from mod_tracker.issues')
      expect(inB.rows[0].n).toBe(1)

      // no context at all means no rows, and no wildcard escape hatch exists
      await client.query(`select set_config('app.workspace_id', '', true)`)
      const nowhere = await client.query('select count(*)::int as n from mod_tracker.issues')
      expect(nowhere.rows[0].n).toBe(0)
      await client.query(`select set_config('app.workspace_id', '*', true)`)
      const wildcard = await client.query('select count(*)::int as n from mod_tracker.issues')
      expect(wildcard.rows[0].n).toBe(0)

      // writing into another workspace is rejected by the policy's WITH CHECK
      await client.query(`select set_config('app.workspace_id', $1, true)`, [WS_B])
      await expect(
        client.query(`insert into mod_tracker.labels (workspace_id, name) values ($1, 'smuggled')`, [WS_A]),
      ).rejects.toThrow(/row-level security/i)
      await client.query('rollback')
    } finally {
      await client.query('rollback').catch(() => undefined)
      await client.end()
    }
  })

  it('moves an issue to another project and re-keys it', async () => {
    const source = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'MVA', name: 'Move A', template: 'simple' } as never),
    )
    const target = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'MVB', name: 'Move B', template: 'simple' } as never),
    )
    const issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId: source.id, title: 'Travelling' } as never),
    )
    expect(issue.key).toBe('MVA-1')
    const moved = await run((tx) => svc.issues.move(tx, alice(), WS_A, issue.id, target.id))
    expect(moved.key).toBe('MVB-1')
    expect(moved.projectId).toBe(target.id)
  })

  it('deletes a project and everything under it', async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'DEL', name: 'Delete', template: 'simple' } as never),
    )
    const issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId: project.id, title: 'Doomed' } as never),
    )
    await run((tx) => svc.projects.delete(tx, alice(), WS_A, project.id))
    await expect(run((tx) => svc.issues.get(tx, alice(), WS_A, issue.id))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const remaining = await run((tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(issues).where(sql`project_id = ${project.id}`),
    )
    expect(remaining[0]!.n).toBe(0)
  })
})

describe('error contract', () => {
  it('raises KernError with the codes the HTTP layer maps', async () => {
    await expect(run((tx) => svc.issues.get(tx, alice(), WS_A, randomUUID()))).rejects.toBeInstanceOf(
      KernError,
    )
  })
})

// =====================================================================================

describe('contract conformance', () => {
  /**
   * The oRPC layer validates every output against the contract, so a mapper that drifts from the
   * schema fails the request rather than the type-check. This sweeps the entities the HTTP tests do
   * not touch, so drift is caught here rather than by a client.
   */
  const valid = <T>(
    schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
    value: T,
  ) => {
    const result = schema.safeParse(value)
    if (!result.success) throw new Error(JSON.stringify(result.error, null, 2))
    return true
  }

  it('returns values that satisfy the contract schemas', async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'CNF',
        name: 'Conformance',
        template: 'software',
        memberIds: [BOB],
      } as never),
    )
    expect(valid(models.Project, project)).toBe(true)
    expect(
      valid(
        models.ProjectMember.array(),
        await run((tx) => svc.projects.listMembers(tx, alice(), WS_A, project.id)),
      ),
    ).toBe(true)
    expect(
      valid(
        models.ProjectTemplate,
        await run((tx) => svc.projects.saveTemplateFromProject(tx, alice(), WS_A, project.id, 'Snapshot')),
      ),
    ).toBe(true)

    const types = await run((tx) => svc.config.listTypes(tx, WS_A, { projectId: project.id }))
    expect(
      valid(
        models.WorkItemType.array(),
        types.map((t) => svc.config.toContractType(t)),
      ),
    ).toBe(true)
    expect(valid(models.HierarchyRules, await run((tx) => svc.config.hierarchyRules(tx, WS_A)))).toBe(true)
    expect(
      valid(
        models.TypeScheme,
        await run((tx) =>
          svc.config.createTypeScheme(tx, WS_A, { name: 'Scheme', typeIds: types.map((t) => t.id) }),
        ),
      ),
    ).toBe(true)

    const field = await run((tx) =>
      svc.config.createField(tx, WS_A, {
        projectId: project.id,
        key: 'impact',
        name: 'Impact',
        type: 'select',
        options: [{ id: 'high', label: 'High', color: null, order: 0, archived: false }],
      }),
    )
    expect(valid(models.FieldDef, field)).toBe(true)
    expect(
      valid(
        models.ResolvedLayout,
        await run(async (tx) => {
          const [firstType] = await svc.config.listTypes(tx, WS_A, { projectId: project.id })
          return svc.layout.resolve(tx, WS_A, project.id, firstType!.id)
        }),
      ),
    ).toBe(true)

    const workflows = await run((tx) => svc.config.listWorkflows(tx, WS_A, { projectId: project.id }))
    expect(valid(models.Workflow.array(), workflows)).toBe(true)
    expect(
      valid(
        models.WorkflowScheme,
        await run((tx) =>
          svc.config.createWorkflowScheme(tx, WS_A, {
            name: 'Default',
            defaultWorkflowId: workflows[0]!.id,
            mappings: [],
          }),
        ),
      ),
    ).toBe(true)
    expect(
      valid(
        models.StatusInfo.array(),
        await run((tx) => svc.config.statusesForProject(tx, WS_A, project.id)),
      ),
    ).toBe(true)

    const issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId: project.id,
        title: 'Conforming issue',
        custom: { impact: 'high' },
      } as never),
    )
    expect(valid(models.Issue, issue)).toBe(true)
    expect(
      valid(
        models.AvailableTransition.array(),
        await run((tx) => svc.transitions.available(tx, alice(), WS_A, issue.id)),
      ),
    ).toBe(true)

    const comment = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, issue.id, {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      }),
    )
    expect(valid(models.Comment, comment)).toBe(true)

    const other = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId: project.id, title: 'Related' } as never),
    )
    expect(
      valid(
        models.RelationView.array(),
        await run((tx) => svc.issues.createRelation(tx, alice(), WS_A, issue.id, 'relates', other.id)),
      ),
    ).toBe(true)
    expect(
      valid(
        models.Attachment.array(),
        await run((tx) => svc.issues.addAttachments(tx, alice(), WS_A, issue.id, [randomUUID()])),
      ),
    ).toBe(true)
    expect(
      valid(
        models.Link,
        await run((tx) =>
          svc.issues.addLink(tx, alice(), WS_A, issue.id, { url: 'https://example.test', kind: 'generic' }),
        ),
      ),
    ).toBe(true)
    expect(
      valid(
        models.IssueTemplate,
        await run((tx) =>
          svc.issues.createTemplate(tx, alice(), WS_A, {
            projectId: project.id,
            name: 'Bug report',
            defaults: { priority: 'high' },
            subItems: [{ title: 'Reproduce' }],
          } as never),
        ),
      ),
    ).toBe(true)
    expect(
      valid(
        models.RecurringIssue,
        await run((tx) =>
          svc.issues.createRecurring(tx, alice(), WS_A, project.id, {
            name: 'Weekly review',
            rule: { freq: 'weekly', interval: 1, at: '09:00' },
            defaults: { title: 'Weekly review' },
          } as never),
        ),
      ),
    ).toBe(true)

    const cycle = await run((tx) =>
      svc.planning.createCycle(tx, alice(), WS_A, project.id, {
        startAt: new Date().toISOString(),
        endAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    )
    expect(valid(models.Cycle, cycle)).toBe(true)
    expect(
      valid(
        models.Milestone,
        await run((tx) => svc.planning.createMilestone(tx, alice(), WS_A, project.id, { name: 'M1' })),
      ),
    ).toBe(true)
    expect(
      valid(
        models.Version,
        await run((tx) => svc.planning.createVersion(tx, alice(), WS_A, project.id, { name: 'v1' })),
      ),
    ).toBe(true)
    expect(
      valid(
        models.Component,
        await run((tx) => svc.planning.createComponent(tx, alice(), WS_A, project.id, { name: 'Core' })),
      ),
    ).toBe(true)
    expect(
      valid(
        models.Label,
        await run((tx) => svc.planning.createLabel(tx, alice(), WS_A, { projectId: project.id, name: 'ux' })),
      ),
    ).toBe(true)
    expect(
      valid(
        models.View,
        await run((tx) =>
          svc.views.create(tx, alice(), WS_A, {
            projectId: project.id,
            name: 'Conforming view',
            kql: 'priority = high',
            layout: 'list',
            visibility: 'private',
          } as never),
        ),
      ),
    ).toBe(true)

    const logged = await run((tx) =>
      svc.time.create(tx, alice(), WS_A, issue.id, { durationSec: 60, adjustRemaining: 'leave' }),
    )
    expect(valid(models.Worklog, logged.worklog)).toBe(true)
    expect(valid(models.Issue, logged.issue)).toBe(true)
    expect(valid(models.Timer, await run((tx) => svc.time.start(tx, alice(), WS_A, issue.id)))).toBe(true)
    await run((tx) => svc.time.stop(tx, alice(), WS_A, true))

    expect(
      valid(
        models.ImportJob,
        await run((tx) =>
          svc.imports.start(tx, alice(), WS_A, project.id, {
            source: 'csv',
            fileId: randomUUID(),
            mapping: { columns: { Summary: 'title' } },
          }),
        ),
      ),
    ).toBe(true)

    expect(
      valid(models.KqlParseResult, await run((tx) => svc.query.parse(tx, alice(), WS_A, 'priority = high'))),
    ).toBe(true)
    expect(
      valid(
        models.KqlFieldInfo.array(),
        await run((tx) => svc.query.fieldInfo(tx, alice(), WS_A, [project.id])),
      ),
    ).toBe(true)
    expect(
      valid(
        models.IssueQueryResult,
        await run((tx) =>
          svc.query.query(tx, alice(), {
            workspaceId: WS_A as IssueQueryInput['workspaceId'],
            kql: '',
            projectIds: [project.id],
            limit: 50,
            includeArchived: false,
            groupBy: 'status',
            include: { total: true, groupCounts: true, full: true },
          } as IssueQueryInput),
        ),
      ),
    ).toBe(true)

    await run((tx) => svc.planning.startCycle(tx, alice(), WS_A, cycle.id))
    const day = new Date().toISOString().slice(0, 10)
    expect(
      valid(models.BurndownReport, await run((tx) => svc.reports.burndown(tx, alice(), WS_A, cycle.id))),
    ).toBe(true)
    expect(
      valid(models.VelocityReport, await run((tx) => svc.reports.velocity(tx, alice(), WS_A, project.id, 6))),
    ).toBe(true)
    expect(
      valid(models.CfdReport, await run((tx) => svc.reports.cfd(tx, alice(), WS_A, project.id, day, day))),
    ).toBe(true)
    expect(
      valid(
        models.CreatedVsResolvedReport,
        await run((tx) => svc.reports.createdVsResolved(tx, alice(), WS_A, project.id, day, day)),
      ),
    ).toBe(true)
    expect(
      valid(
        models.TimeReport,
        await run((tx) =>
          svc.reports.time(tx, alice(), WS_A, {
            from: day,
            to: day,
            projectId: project.id,
            billableOnly: false,
          }),
        ),
      ),
    ).toBe(true)
  })
})

// =====================================================================================

describe('configuration authorisation', () => {
  /**
   * Issue templates and recurring rules decide what everyone else's issues look like, and watchers
   * decide whose inbox an issue lands in. None of them are ordinary issue content, so viewing an
   * issue must not be enough to change them. Each case below is a hole this suite exists to keep
   * closed: before these guards a guest could rewrite a project's templates, schedule issues into
   * it, or silently unsubscribe the reporter.
   */
  let projectId: string
  let issueId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'AUZ',
        name: 'Authorisation',
        template: 'simple',
        memberIds: [BOB, CAROL],
      } as never),
    )
    projectId = project.id
    const issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId, title: 'Guarded' } as CreateIssue),
    )
    issueId = issue.id
  })

  const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'FORBIDDEN' })

  it('lets only project managers create, edit and delete issue templates', async () => {
    await forbidden(
      run((tx) => svc.issues.createTemplate(tx, guest(), WS_A, { projectId, name: 'Sneaky' } as never)),
    )
    const template = await run((tx) =>
      svc.issues.createTemplate(tx, alice(), WS_A, { projectId, name: 'Bug report' } as never),
    )
    await forbidden(
      run((tx) => svc.issues.updateTemplate(tx, guest(), WS_A, template.id, { name: 'Hijacked' })),
    )
    await forbidden(run((tx) => svc.issues.deleteTemplate(tx, guest(), WS_A, template.id)))
    const renamed = await run((tx) =>
      svc.issues.updateTemplate(tx, alice(), WS_A, template.id, { name: 'Defect report' }),
    )
    expect(renamed.name).toBe('Defect report')
    await run((tx) => svc.issues.deleteTemplate(tx, alice(), WS_A, template.id))
  })

  it('hides templates of projects the caller cannot see', async () => {
    const secret = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, {
        key: 'AZS',
        name: 'Authorisation secret',
        template: 'simple',
        visibility: 'private',
        memberIds: [],
      } as never),
    )
    await run((tx) =>
      svc.issues.createTemplate(tx, alice(), WS_A, { projectId: secret.id, name: 'Private' } as never),
    )
    await run((tx) => svc.issues.createTemplate(tx, alice(), WS_A, { name: 'Shared' } as never))
    const seen = await run((tx) => svc.issues.listTemplates(tx, guest(), WS_A))
    expect(seen.map((t) => t.name)).toContain('Shared')
    expect(seen.map((t) => t.name)).not.toContain('Private')
  })

  it('lets only project managers schedule recurring issues', async () => {
    const rule = { freq: 'weekly', interval: 1 }
    await forbidden(
      run((tx) =>
        svc.issues.createRecurring(tx, guest(), WS_A, projectId, {
          name: 'Spam',
          rule,
          defaults: { title: 'Spam' },
        } as never),
      ),
    )
    const recurring = await run((tx) =>
      svc.issues.createRecurring(tx, alice(), WS_A, projectId, {
        name: 'Weekly review',
        rule,
        defaults: { title: 'Weekly review' },
      } as never),
    )
    await forbidden(
      run((tx) => svc.issues.updateRecurring(tx, guest(), WS_A, recurring.id, { enabled: false })),
    )
    await forbidden(run((tx) => svc.issues.deleteRecurring(tx, guest(), WS_A, recurring.id)))
    // a guest who can see the project may still read the schedule
    const listed = await run((tx) => svc.issues.listRecurring(tx, guest(), WS_A, projectId))
    expect(listed.map((r) => r.name)).toContain('Weekly review')
    await run((tx) => svc.issues.deleteRecurring(tx, alice(), WS_A, recurring.id))
  })

  it('lets anyone watch themselves but not subscribe or unsubscribe other people', async () => {
    const self = await run((tx) => svc.issues.setWatcher(tx, guest(), WS_A, issueId, CAROL, true))
    expect(self.watcherIds).toContain(CAROL)
    await forbidden(run((tx) => svc.issues.setWatcher(tx, guest(), WS_A, issueId, ALICE, false)))
    await forbidden(run((tx) => svc.issues.setWatcher(tx, guest(), WS_A, issueId, BOB, true)))
    const byMember = await run((tx) => svc.issues.setWatcher(tx, bob(), WS_A, issueId, CAROL, false))
    expect(byMember.watcherIds).not.toContain(CAROL)
  })
})

// =====================================================================================

describe('workflow and field definition guards', () => {
  let projectId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'GRD', name: 'Guards', template: 'software' } as never),
    )
    projectId = project.id
  })

  const withUnknownRule = (id: string) => ({
    id,
    name: 'Unknown rule',
    statuses: [
      { id: 'open', name: 'Open', category: 'todo' as const, order: 0, initial: true },
      { id: 'done', name: 'Done', category: 'done' as const, order: 1 },
    ],
    transitions: [
      {
        id: 'finish',
        name: 'Finish',
        from: ['open'],
        to: 'done',
        conditions: [{ type: 'tracker.no_such_condition', config: {} }],
      },
    ],
  })

  it('refuses to save a workflow whose rule type does not exist', async () => {
    // `validate` and `create` must agree. They did not: `create` skipped the rule registry, so an
    // unknown condition saved happily and only surfaced as a transition nobody could take.
    const reported = svc.config.validate(withUnknownRule('unknown-a'))
    expect(reported.ok).toBe(false)

    await expect(
      run((tx) =>
        svc.config.createWorkflow(tx, WS_A, {
          projectId,
          name: 'Unknown rule',
          definition: withUnknownRule('unknown-a'),
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses to update a workflow into a rule type that does not exist', async () => {
    const created = await run((tx) =>
      svc.config.createWorkflow(tx, WS_A, {
        projectId,
        name: 'Sound',
        definition: {
          id: 'sound',
          name: 'Sound',
          statuses: [
            { id: 'open', name: 'Open', category: 'todo', order: 0, initial: true },
            { id: 'done', name: 'Done', category: 'done', order: 1 },
          ],
          transitions: [{ id: 'finish', name: 'Finish', from: ['open'], to: 'done' }],
        } as never,
      }),
    )
    await expect(
      run((tx) =>
        svc.config.updateWorkflow(tx, WS_A, created.id, {
          definition: withUnknownRule('sound'),
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('only counts issues of the types this workflow governs when a status is removed', async () => {
    // Two workflows in one workspace. Removing a status from one used to be blocked by an issue
    // sitting in a same-named status of the *other* one, because the count was workspace-wide.
    const other = await run((tx) =>
      svc.config.createWorkflow(tx, WS_A, {
        projectId,
        name: 'Other flow',
        definition: {
          id: 'other',
          name: 'Other flow',
          statuses: [
            { id: 'open', name: 'Open', category: 'todo', order: 0, initial: true },
            { id: 'parked', name: 'Parked', category: 'todo', order: 1 },
          ],
          transitions: [{ id: 'park', name: 'Park', from: ['open'], to: 'parked' }],
        } as never,
      }),
    )
    const otherType = await run((tx) =>
      svc.config.createType(
        tx,
        WS_A,
        { projectId, key: 'parked_thing', name: 'Parked thing', level: 0, workflowId: other.id } as never,
        ALICE,
      ),
    )
    const parked = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Sitting in parked',
        typeId: otherType.id,
      } as never),
    )
    await run((tx) => svc.transitions.apply(tx, alice(), WS_A, parked.id, { transitionId: 'park' }))

    // A third workflow that nothing uses. Dropping a status from it must not consult `parked`.
    const spare = await run((tx) =>
      svc.config.createWorkflow(tx, WS_A, {
        projectId,
        name: 'Spare flow',
        definition: {
          id: 'spare',
          name: 'Spare flow',
          statuses: [
            { id: 'open', name: 'Open', category: 'todo', order: 0, initial: true },
            { id: 'parked', name: 'Parked', category: 'todo', order: 1 },
          ],
          transitions: [{ id: 'park', name: 'Park', from: ['open'], to: 'parked' }],
        } as never,
      }),
    )
    const spareType = await run((tx) =>
      svc.config.createType(
        tx,
        WS_A,
        { projectId, key: 'spare_thing', name: 'Spare thing', level: 0, workflowId: spare.id } as never,
        ALICE,
      ),
    )
    expect(spareType.workflowId).toBe(spare.id)

    const narrowed = await run((tx) =>
      svc.config.updateWorkflow(tx, WS_A, spare.id, {
        definition: {
          id: 'spare',
          name: 'Spare flow',
          statuses: [{ id: 'open', name: 'Open', category: 'todo', order: 0, initial: true }],
          transitions: [],
        },
      } as never),
    )
    expect(narrowed.definition.statuses.map((s) => s.id)).toEqual(['open'])
  })

  it('matches a relation field, which is stored as an array even when single-valued', async () => {
    // A relation always stores string[]. KQL compiled it as scalar text, so `cf.blocked_by = <id>`
    // compared an array against a string and matched nothing, silently.
    await run((tx) =>
      svc.config.createField(tx, WS_A, {
        projectId,
        key: 'related_to',
        name: 'Related to',
        type: 'relation',
      } as never),
    )
    const target = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId, title: 'The target' } as never),
    )
    const source = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, {
        projectId,
        title: 'Points at the target',
        custom: { related_to: [target.id] },
      } as never),
    )
    const found = await run((tx) =>
      svc.query.query(tx, alice(), {
        workspaceId: WS_A as IssueQueryInput['workspaceId'],
        kql: `cf.related_to = "${target.id}"`,
        projectIds: [projectId],
        limit: 10,
        includeArchived: false,
        include: { total: false, groupCounts: false, full: false },
      } as IssueQueryInput),
    )
    expect(found.items.map((i) => i.id)).toEqual([source.id])
  })

  it('keeps a custom field key unique across the whole workspace', async () => {
    // The key is the `issues.custom` key, so a project-scoped duplicate of a workspace-level field
    // would write to the same place. The database constraint and this check must agree.
    await run((tx) =>
      svc.config.createField(tx, WS_A, { key: 'guard_scope', name: 'Guard scope', type: 'text' } as never),
    )
    await expect(
      run((tx) =>
        svc.config.createField(tx, WS_A, {
          projectId,
          key: 'guard_scope',
          name: 'Guard scope again',
          type: 'text',
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

// =====================================================================================

describe('resolved field layout', () => {
  let projectId: string
  let typeId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'LAY', name: 'Layout', template: 'software' } as never),
    )
    projectId = project.id
    const types = await run((tx) => svc.config.listTypes(tx, WS_A, { projectId }))
    typeId = types.find((t) => t.key === 'bug')!.id
  })

  const resolve = () => run((tx) => svc.layout.resolve(tx, WS_A, projectId, typeId))

  it('shows every field when the type has no stored layout', async () => {
    // Every type starts with `fieldLayout: []`. If that meant "hide everything", deploying this
    // would blank the issue panel of every existing workspace.
    const layout = await resolve()
    expect(layout.hidden).toEqual([])
    expect(layout.main.map((f) => f.fieldId)).toContain('title')
    expect(layout.sidebar.map((f) => f.fieldId)).toEqual(
      expect.arrayContaining(['status', 'priority', 'dueDate']),
    )
  })

  it('appends a newly created field instead of hiding it', async () => {
    await run((tx) =>
      svc.config.createField(tx, WS_A, {
        projectId,
        key: 'severity_level',
        name: 'Severity level',
        type: 'select',
        options: [
          { id: 'sev1', label: 'Sev 1', color: null, order: 0, archived: false },
          { id: 'sev2', label: 'Sev 2', color: null, order: 1, archived: false },
        ],
      } as never),
    )
    // The layout is still `[]`, so it names nothing — the field must appear anyway.
    const layout = await resolve()
    const found = layout.sidebar.find((f) => f.fieldId === 'cf.severity_level')
    expect(found).toMatchObject({ kind: 'custom', label: 'Severity level' })
    expect(found!.field?.options.map((o) => o.id)).toEqual(['sev1', 'sev2'])
  })

  it('moves a field to main, hides a built-in one, and keeps pinned fields visible', async () => {
    await run((tx) =>
      svc.config.updateType(tx, WS_A, typeId, {
        fieldLayout: [
          { fieldId: 'cf.severity_level', section: 'main', order: 1, required: true, hidden: false },
          { fieldId: 'dueDate', section: 'hidden', order: 0, required: false, hidden: true },
          // an attempt to hide a pinned field, which the resolver must refuse
          { fieldId: 'status', section: 'hidden', order: 0, required: false, hidden: true },
        ],
      } as never),
    )
    const layout = await resolve()
    expect(layout.main.map((f) => f.fieldId)).toContain('cf.severity_level')
    expect(layout.main.find((f) => f.fieldId === 'cf.severity_level')!.required).toBe(true)
    expect(layout.hidden.map((f) => f.fieldId)).toEqual(['dueDate'])
    expect(layout.sidebar.map((f) => f.fieldId)).toContain('status')
    expect(layout.sidebar.find((f) => f.fieldId === 'status')!.pinned).toBe(true)
  })

  it('drops an archived field from every section', async () => {
    const field = await run((tx) =>
      svc.config.createField(tx, WS_A, {
        projectId,
        key: 'retired_field',
        name: 'Retired',
        type: 'text',
      } as never),
    )
    expect((await resolve()).sidebar.map((f) => f.fieldId)).toContain('cf.retired_field')
    await run((tx) => svc.config.archiveField(tx, WS_A, field.id, true))
    const after = await resolve()
    const everywhere = [...after.main, ...after.sidebar, ...after.hidden].map((f) => f.fieldId)
    expect(everywhere).not.toContain('cf.retired_field')
  })
})

// =====================================================================================

describe('transition screens', () => {
  let projectId: string
  let typeId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'SCR', name: 'Screens', template: 'software' } as never),
    )
    projectId = project.id
    await run((tx) =>
      svc.config.createField(tx, WS_A, {
        projectId,
        key: 'closing_note',
        name: 'Closing note',
        type: 'text',
      } as never),
    )
    await run((tx) =>
      svc.config.createField(tx, WS_A, {
        projectId,
        key: 'never_on_a_screen',
        name: 'Not on any screen',
        type: 'text',
      } as never),
    )
    const workflow = await run((tx) =>
      svc.config.createWorkflow(tx, WS_A, {
        projectId,
        name: 'Screen flow',
        definition: {
          id: 'screen',
          name: 'Screen flow',
          statuses: [
            { id: 'open', name: 'Open', category: 'todo', order: 0, initial: true },
            { id: 'closed', name: 'Closed', category: 'done', order: 1 },
          ],
          transitions: [
            {
              id: 'close',
              name: 'Close',
              from: ['open'],
              to: 'closed',
              screen: { fields: ['cf.closing_note', 'priority'], comment: false },
            },
          ],
        } as never,
      }),
    )
    const type = await run((tx) =>
      svc.config.createType(
        tx,
        WS_A,
        { projectId, key: 'screened', name: 'Screened', level: 0, workflowId: workflow.id } as never,
        ALICE,
      ),
    )
    typeId = type.id
  })

  const newIssue = () =>
    run((tx) => svc.issues.create(tx, alice(), WS_A, { projectId, title: 'Screened', typeId } as never))

  it('saves the values a transition screen collects', async () => {
    // These used to reach the rule engine and then be dropped, so a screen only appeared to work
    // when a `field.set` post-function repeated the value.
    const issue = await newIssue()
    const { issue: closed } = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, issue.id, {
        transitionId: 'close',
        fields: { 'cf.closing_note': 'Fixed in 1.2', priority: 'high' },
      } as never),
    )
    expect(closed.statusId).toBe('closed')
    expect(closed.custom.closing_note).toBe('Fixed in 1.2')
    expect(closed.priority).toBe('high')
  })

  it('ignores a field the screen does not declare', async () => {
    // `tracker.issue.transition` is narrower than `tracker.issue.update`; an unfiltered patch here
    // would be a way to write fields the actor may not be allowed to change.
    const issue = await newIssue()
    const { issue: closed } = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, issue.id, {
        transitionId: 'close',
        fields: { 'cf.never_on_a_screen': 'sneaked in' },
      } as never),
    )
    expect(closed.custom.never_on_a_screen).toBeUndefined()
  })

  it('rejects a screen value that fails its field validation', async () => {
    const issue = await newIssue()
    await expect(
      run((tx) =>
        svc.transitions.apply(tx, alice(), WS_A, issue.id, {
          transitionId: 'close',
          fields: { 'cf.closing_note': 42 },
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

// =====================================================================================

describe('comment attachments', () => {
  let projectId: string
  let issueId: string
  const forbidden = (pr: Promise<unknown>) => expect(pr).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const doc = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'ATT', name: 'Attach', template: 'software' } as never),
    )
    projectId = project.id
    const issue = await run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId, title: 'Has files' } as never),
    )
    issueId = issue.id
  })

  it('records which comment a file arrived with, and still lists it on the issue', async () => {
    const comment = await run((tx) =>
      svc.comments.create(tx, alice(), WS_A, issueId, doc('Screenshot attached') as never),
    )
    const fileId = randomUUID()
    const [attached] = await run((tx) =>
      svc.issues.addAttachments(tx, alice(), WS_A, issueId, [fileId], comment.id),
    )
    expect(attached!.commentId).toBe(comment.id)

    // an attachment belongs to the issue and *optionally* to a comment
    const all = await run((tx) => svc.issues.listAttachments(tx, alice(), WS_A, issueId))
    expect(all.map((a) => a.fileId)).toContain(fileId)
  })

  it('lets somebody who may comment but not edit attach a file to their own comment', async () => {
    // A guest can reply; a guest cannot edit the issue. Attaching a screenshot to a reply is part
    // of replying, so it must not require the edit permission.
    const comment = await inWs(
      WS_A,
      guest(),
    )((tx) => svc.comments.create(tx, guest(), WS_A, issueId, doc('From a guest') as never))
    const fileId = randomUUID()
    const [attached] = await inWs(
      WS_A,
      guest(),
    )((tx) => svc.issues.addAttachments(tx, guest(), WS_A, issueId, [fileId], comment.id))
    expect(attached!.commentId).toBe(comment.id)

    // and the same guest may take it back off, because the comment is theirs
    await inWs(WS_A, guest())((tx) => svc.issues.removeAttachment(tx, guest(), WS_A, attached!.id))
    const left = await run((tx) => svc.issues.listAttachments(tx, alice(), WS_A, issueId))
    expect(left.map((a) => a.fileId)).not.toContain(fileId)
  })

  it('still refuses a guest attaching to the issue itself', async () => {
    await forbidden(
      inWs(WS_A, guest())((tx) => svc.issues.addAttachments(tx, guest(), WS_A, issueId, [randomUUID()])),
    )
  })
})

// =====================================================================================

describe('approvals addressed to a group or a role', () => {
  let projectId: string

  beforeAll(async () => {
    const project = await run((tx) =>
      svc.projects.create(tx, alice(), WS_A, { key: 'APR', name: 'Approve', template: 'software' } as never),
    )
    projectId = project.id
  })

  const flowFor = async (name: string, approver: { kind: string; id: string }) => {
    const workflow = await run((tx) =>
      svc.config.createWorkflow(tx, WS_A, {
        projectId,
        name,
        definition: {
          id: name,
          name,
          statuses: [
            { id: 'open', name: 'Open', category: 'todo', order: 0, initial: true },
            { id: 'shipped', name: 'Shipped', category: 'done', order: 1 },
          ],
          transitions: [
            {
              id: 'ship',
              name: 'Ship',
              from: ['open'],
              to: 'shipped',
              approval: { approvers: [approver], minApprovals: 1 },
            },
          ],
        } as never,
      }),
    )
    const type = await run((tx) =>
      svc.config.createType(
        tx,
        WS_A,
        { projectId, key: name, name, level: 0, workflowId: workflow.id } as never,
        ALICE,
      ),
    )
    return run((tx) =>
      svc.issues.create(tx, alice(), WS_A, { projectId, title: name, typeId: type.id } as never),
    )
  }

  it('lets a member of the approving group decide', async () => {
    // A group used to resolve to nobody, so the approval could never be granted and the transition
    // was stuck for good.
    const issue = await flowFor('group_flow', { kind: 'group', id: REVIEWERS_GROUP })
    const parked = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, issue.id, { transitionId: 'ship' }),
    )
    expect(parked.approval).toBeTruthy()
    expect(parked.issue.statusId).toBe('open')

    // Alice is not in the group; Bob is
    await expect(
      run((tx) => svc.transitions.decide(tx, alice(), WS_A, issue.id, 'ship', 'approve')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const decided = await inWs(
      WS_A,
      bob(),
    )((tx) => svc.transitions.decide(tx, bob(), WS_A, issue.id, 'ship', 'approve'))
    expect(decided.approval.state.status).toBe('approved')
    expect(decided.issue?.statusId).toBe('shipped')
  })

  it('lets somebody holding the approving role decide', async () => {
    const issue = await flowFor('role_flow', { kind: 'role', id: REVIEWER_ROLE })
    await run((tx) => svc.transitions.apply(tx, alice(), WS_A, issue.id, { transitionId: 'ship' }))
    const decided = await inWs(
      WS_A,
      bob(),
    )((tx) => svc.transitions.decide(tx, bob(), WS_A, issue.id, 'ship', 'approve'))
    expect(decided.issue?.statusId).toBe('shipped')
  })

  it('matches a built-in role by name', async () => {
    const issue = await flowFor('builtin_flow', { kind: 'role', id: 'admin' })
    const parked = await run((tx) =>
      svc.transitions.apply(tx, alice(), WS_A, issue.id, { transitionId: 'ship' }),
    )
    expect(parked.approval).toBeTruthy()
    const decided = await run((tx) => svc.transitions.decide(tx, alice(), WS_A, issue.id, 'ship', 'approve'))
    expect(decided.issue?.statusId).toBe('shipped')
  })
})
