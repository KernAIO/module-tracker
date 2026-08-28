import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type Tx } from '@kernhq/kernel'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { trackerModule } from './index.js'
import { comments, projects } from './schema.js'
import { type TrackerServices, trackerServices } from './services/index.js'

/**
 * Cross-tenant isolation, as a class rather than as a list of bugs.
 *
 * Every case here hands a service an id that belongs to **workspace A** while the transaction is
 * scoped to **workspace B**. A query whose `WHERE` is only `eq(table.id, input.something)` finds
 * that row and acts on it, which is how a reply-count landed on a stranger's comment and how
 * deleting a type scheme detached another tenant's projects.
 *
 * Two layers are asserted, because each is a defence the other does not provide:
 *
 *  1. **the service**, which must answer the module's honest *not found* — never `forbidden`, which
 *     would confirm the row exists — or simply decline to act on the foreign row;
 *  2. **row-level security**, which is only observable under a role that cannot bypass it. The
 *     development user is a superuser and superusers bypass RLS entirely, so the probe below opens
 *     a second connection as an explicit `nosuperuser nobypassrls` role. Without that, these
 *     assertions would pass against tables carrying no policy at all.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_tracker_iso_${Date.now().toString(36)}`
const RLS_ROLE = `kern_tracker_iso_rls_${Date.now().toString(36)}`

let kernel: Kernel
let svc: TrackerServices
let admin: pg.Client
let databaseUrl: string

const WS_A = randomUUID()
const WS_B = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()
/** Lead of A's component. If B can read that component, this id lands on one of B's issues. */
const CAROL = randomUUID()

const principal = (userId: string, workspaceId: string): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId, role: 'admin', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const inA = principal(ALICE, WS_A)
const inB = principal(BOB, WS_B)

const run =
  (workspaceId: string, actor: Principal) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: actor.userId })

const runA = run(WS_A, inA)
const runB = run(WS_B, inB)

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'workspaces.members': { handler: async () => [] },
    'users.principal': {
      handler: async (input: { userId: string }) => principal(input.userId, WS_A),
    },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({}) },
  })
}

/** Seeded in A, and named by the tests as the id a caller in B tries to reach. */
let projectA: string
let issueA: string
let commentA: string
let componentA: string
let schemeA: string
/** Seeded in B, so a cross-tenant call has somewhere legitimate to stand. */
let issueB: string

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'tracker-isolation-test',
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

  // ---------------------------------------------------------------- workspace A
  const pa = await runA((tx) =>
    svc.projects.create(tx, inA, WS_A, {
      key: 'aaa',
      name: 'Alpha',
      template: 'simple',
      visibility: 'workspace',
      defaultAssignee: 'unassigned',
      memberIds: [ALICE, CAROL],
    } as never),
  )
  projectA = pa.id

  const ia = await runA((tx) =>
    svc.issues.create(tx, inA, WS_A, { projectId: projectA, title: 'Alpha issue' } as never),
  )
  issueA = ia.id

  const ca = await runA((tx) => svc.comments.create(tx, inA, WS_A, issueA, doc('alpha thread') as never))
  commentA = ca.id

  const comp = await runA((tx) =>
    svc.planning.createComponent(tx, inA, WS_A, projectA, {
      name: 'Alpha component',
      leadId: CAROL,
      defaultAssignee: 'lead',
    } as never),
  )
  componentA = comp.id

  const scheme = await runA((tx) =>
    svc.config.createTypeScheme(tx, WS_A, { name: 'Alpha types', typeIds: [] }),
  )
  schemeA = scheme.id
  await runA((tx) =>
    tx
      .update(projects)
      .set({ typeSchemeId: schemeA })
      .where(and(eq(projects.workspaceId, WS_A), eq(projects.id, projectA))),
  )

  // ---------------------------------------------------------------- workspace B
  const pb = await runB((tx) =>
    svc.projects.create(tx, inB, WS_B, {
      key: 'bbb',
      name: 'Beta',
      template: 'simple',
      visibility: 'workspace',
      defaultAssignee: 'unassigned',
      memberIds: [BOB],
    } as never),
  )
  const ib = await runB((tx) =>
    svc.issues.create(tx, inB, WS_B, { projectId: pb.id, title: 'Beta issue' } as never),
  )
  issueB = ib.id
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin?.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

describe('an id from workspace A, used from workspace B', () => {
  it('cannot be replied to, and does not gain a reply', async () => {
    // `parentId` used to be written straight onto the new row and then incremented by a bare
    // `eq(comments.id, parentId)` — so a reply filed in B raised the reply count of a comment in A.
    await expect(
      runB((tx) =>
        svc.comments.create(tx, inB, WS_B, issueB, doc('smuggled reply') as never, {
          parentId: commentA,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const [parent] = await runA((tx) =>
      tx
        .select()
        .from(comments)
        .where(and(eq(comments.workspaceId, WS_A), eq(comments.id, commentA))),
    )
    expect(parent?.replyCount, "A's comment gained a reply from another workspace").toBe(0)
  })

  it("does not hand over a project's member list", async () => {
    // `tracker.projects.members` is service-to-service, so the caller is trusted to name a
    // workspace — which is exactly why the query has to constrain the rows to the one it was given.
    const own = await kernel.call<{ userIds: string[] }>('tracker.projects.members', {
      workspaceId: WS_A,
      projectId: projectA,
    })
    expect(own.userIds).toContain(ALICE)

    const across = await kernel.call<{ userIds: string[] }>('tracker.projects.members', {
      workspaceId: WS_B,
      projectId: projectA,
    })
    expect(across.userIds, "B was told who works on A's project").toEqual([])
  })

  it("does not assign one workspace's component lead to another workspace's issue", async () => {
    // `defaultAssignees` read `components` by the caller's ids with no workspace predicate, so a
    // component in A whose default assignee is its lead put that lead on an issue created in B.
    const [projectB] = await runB((tx) =>
      tx.select().from(projects).where(eq(projects.workspaceId, WS_B)).limit(1),
    )
    const created = await runB((tx) =>
      svc.issues.create(tx, inB, WS_B, {
        projectId: projectB!.id,
        title: 'Borrowed component',
        componentIds: [componentA],
      } as never),
    )
    expect(created.assigneeIds, "A's component lead was assigned to an issue in B").not.toContain(CAROL)
  })

  it('is not detached by a delete issued from the other workspace', async () => {
    // `deleteTypeScheme` nulled `projects.type_scheme_id` for the id across *every* workspace while
    // deleting only its own row — so B could quietly unconfigure A's projects.
    await runB((tx) => svc.config.deleteTypeScheme(tx, WS_B, schemeA))

    const [project] = await runA((tx) =>
      tx
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, WS_A), eq(projects.id, projectA))),
    )
    expect(project?.typeSchemeId, "A's project was detached from its type scheme by B").toBe(schemeA)
  })
})

/**
 * The same question asked of Postgres rather than of the service layer.
 *
 * `nosuperuser nobypassrls` is the whole point: the pool in a default deployment connects as the
 * superuser, which bypasses every policy, so this is the only role that can tell a working policy
 * from a missing one.
 */
describe('row-level security, under a role that cannot bypass it', () => {
  let plain: pg.Client

  beforeAll(async () => {
    const scratch = new pg.Client({ connectionString: databaseUrl })
    await scratch.connect()
    await scratch.query(`create role "${RLS_ROLE}" login password 'probe' nosuperuser nobypassrls`)
    await scratch.query(`grant usage on schema mod_tracker to "${RLS_ROLE}"`)
    await scratch.query(
      `grant select, insert, update, delete on all tables in schema mod_tracker to "${RLS_ROLE}"`,
    )
    await scratch.end()

    const url = new URL(databaseUrl)
    url.username = RLS_ROLE
    url.password = 'probe'
    plain = new pg.Client({ connectionString: url.toString() })
    await plain.connect()
  }, 60_000)

  afterAll(async () => {
    await plain?.end().catch(() => undefined)
  })

  it("hides A's rows from a session scoped to B", async () => {
    // `false` is load-bearing: the third argument is `is_local`, and a *local* setting lasts only
    // for the current transaction — which, for an implicit single-statement one, is already over by
    // the next query. Set it locally here and every assertion below passes vacuously, against a
    // session that simply has no workspace and can therefore see nothing at all.
    await plain.query(`select set_config('app.workspace_id', $1, false)`, [WS_B])
    const seen = await plain.query<{ n: number }>(
      `select count(*)::int as n from mod_tracker.issues where id = $1`,
      [issueA],
    )
    expect(seen.rows[0]?.n).toBe(0)
    const comment = await plain.query<{ n: number }>(
      `select count(*)::int as n from mod_tracker.comments where id = $1`,
      [commentA],
    )
    expect(comment.rows[0]?.n).toBe(0)
  })

  it("refuses to mutate A's rows from a session scoped to B", async () => {
    // `false` is load-bearing: the third argument is `is_local`, and a *local* setting lasts only
    // for the current transaction — which, for an implicit single-statement one, is already over by
    // the next query. Set it locally here and every assertion below passes vacuously, against a
    // session that simply has no workspace and can therefore see nothing at all.
    await plain.query(`select set_config('app.workspace_id', $1, false)`, [WS_B])
    const updated = await plain.query(`update mod_tracker.comments set reply_count = 99 where id = $1`, [
      commentA,
    ])
    expect(updated.rowCount, "B's UPDATE reached a row in A").toBe(0)
  })

  it('still shows each workspace its own rows, so the probe is not vacuous', async () => {
    await plain.query(`select set_config('app.workspace_id', $1, false)`, [WS_A])
    const seen = await plain.query<{ n: number }>(
      `select count(*)::int as n from mod_tracker.issues where id = $1`,
      [issueA],
    )
    expect(seen.rows[0]?.n).toBe(1)
  })
})
