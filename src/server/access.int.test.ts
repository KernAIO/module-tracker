import { randomUUID } from 'node:crypto'
import type { core, Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type Tx } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CreateIssue } from '../contract/models.js'
import { backfillSearchAcls, trackerModule } from './index.js'
import { workspaces } from './schema.js'
import { type TrackerServices, trackerServices } from './services/index.js'

/**
 * What a caller who may see one project actually gets back.
 *
 * The tracker indexed every issue with `acl: null`, and core reads a null acl as "everybody in this
 * workspace" — `(acl is null or acl && subjects)` in `core/src/modules/core/services/search.ts`. So
 * workspace search handed every member the key, title and indexed description of every issue in
 * every project, including projects they were refused when they tried to open one. Two more
 * refusals sat beside it, both reached by the same persona: `views.list` died on a raw Postgres
 * error when the visible-project list was empty, and `projects.list` answered 403 rather than an
 * empty list.
 *
 * Every assertion below is about **what came back**, not about the shape of a document: the acls the
 * module produced are replayed through core's own predicate, in Postgres, so the array-overlap
 * semantics are the real ones rather than a JavaScript approximation of them.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_tracker_access_${Date.now().toString(36)}`

let kernel: Kernel
let svc: TrackerServices
let admin: pg.Client
let probe: pg.Client

const WS = randomUUID()
const ALICE = randomUUID()
const BOB = randomUUID()
const CAROL = randomUUID()

/** Ids filled in `beforeAll`. */
let openProject: string
let otherProject: string
let secretProject: string
const issueIn = new Map<string, string>()

/**
 * `core.search.index` upserts on (workspace, module, type, object), so the last document a test
 * produced for an issue is the one core would be holding.
 */
const indexed = new Map<string, core.SearchDocument>()

/**
 * A guest scoped to one project, exactly as core's `bindingsFor` builds it: a workspace-scoped deny
 * of every permission that is not workspace- or instance-scoped (the "guest floor"), and then an
 * allow on the one project the guest was given. Reproduced here rather than assumed, because the
 * floor is what makes a guest's reach narrow enough for any of this to be observable.
 */
const guestScope = new Map<string, string>()

const principal = (userId: string, role: 'owner' | 'admin' | 'member' | 'guest' = 'admin'): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId.slice(0, 8),
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId: WS, role, roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const alice = () => principal(ALICE, 'admin')
const bob = () => principal(BOB, 'member')
const carol = () => principal(CAROL, 'guest')

const run =
  (actor: Principal) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(WS, fn, { userId: actor.userId })

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': {
      handler: async (input: { documents: core.SearchDocument[] }) => {
        for (const d of input.documents) indexed.set(d.object.id, d)
        return { ok: true }
      },
    },
    'search.remove': {
      handler: async (input: { refs: Array<{ object: { id: string } }> }) => {
        for (const r of input.refs) indexed.delete(r.object.id)
        return { ok: true }
      },
    },
    'modules.isEnabled': { handler: async () => true },
    'workspaces.members': { handler: async () => [] },
    'users.principal': { handler: async (input: { userId: string }) => principal(input.userId) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': {
      handler: async (input: { workspaceId: string; userId: string; role: string }) => {
        if (input.role !== 'guest') return []
        const floor = k.authz
          .allPermissions()
          .filter((p) => p.scope !== 'workspace' && p.scope !== 'instance')
          .map((p) => p.key)
        const bindings = [
          {
            subjectType: 'builtin_role',
            subjectId: 'guest',
            permissions: floor,
            scopeKind: 'workspace',
            scopeId: input.workspaceId,
            deny: true,
          },
        ]
        const scoped = guestScope.get(input.userId)
        if (scoped)
          bindings.push({
            subjectType: 'user',
            subjectId: input.userId,
            permissions: ['tracker.project.view', 'tracker.issue.view'],
            scopeKind: 'project',
            scopeId: scoped,
            deny: false,
          })
        return bindings
      },
    },
    'settings.getModule': { handler: async () => ({}) },
  })
}

/**
 * Core's filter, run by Postgres rather than restated in TypeScript.
 *
 * `subjects` is built the way `search()` builds it, and the predicate is the one it applies. A
 * hand-written `acl.some(s => subjects.includes(s))` would be a *second* implementation of `&&`,
 * and the point of this file is that the module's output survives the real one.
 */
async function searchTitlesFor(who: Principal): Promise<string[]> {
  const membership = who.memberships.find((m) => m.workspaceId === WS)
  const subjects = [who.userId ?? '', ...(membership?.groupIds ?? []), `role:${membership?.role}`].filter(
    Boolean,
  )
  await probe.query('truncate table search_probe')
  for (const d of indexed.values())
    await probe.query('insert into search_probe (object_id, title, acl) values ($1, $2, $3)', [
      d.object.id,
      d.title,
      d.acl,
    ])
  const { rows } = await probe.query<{ title: string }>(
    'select title from search_probe where (acl is null or acl && $1::text[]) order by title',
    [subjects],
  )
  return rows.map((r) => r.title)
}

const titleOf = (key: string) => (titles: string[]) => titles.some((t) => t.startsWith(key))

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'tracker-access-test',
    modules: [trackerModule],
    role: 'api',
    env: {
      DATABASE_URL: url.toString(),
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerCoreStubs(kernel)
  await kernel.start()
  svc = trackerServices(kernel)

  probe = new pg.Client({ connectionString: url.toString() })
  await probe.connect()
  await probe.query('create table search_probe (object_id uuid, title text, acl text[])')

  const open = await run(alice())((tx) =>
    svc.projects.create(tx, alice(), WS, {
      key: 'OPN',
      name: 'Open',
      template: 'simple',
      visibility: 'workspace',
      memberIds: [ALICE],
    } as never),
  )
  openProject = open.id
  const other = await run(alice())((tx) =>
    svc.projects.create(tx, alice(), WS, {
      key: 'OTH',
      name: 'Other',
      template: 'simple',
      visibility: 'workspace',
      memberIds: [ALICE],
    } as never),
  )
  otherProject = other.id
  const secret = await run(alice())((tx) =>
    svc.projects.create(tx, alice(), WS, {
      key: 'SEC',
      name: 'Secret',
      template: 'simple',
      visibility: 'private',
      memberIds: [ALICE],
    } as never),
  )
  secretProject = secret.id

  // The guest is given the one project, which is the whole persona: they may open OPN and nothing
  // else. Set before any issue is created so nothing depends on the order.
  guestScope.set(CAROL, openProject)

  for (const [projectId, title] of [
    [openProject, 'Open work, visible to the workspace'],
    [otherProject, 'Other work, in a project the guest was not given'],
    [secretProject, 'Secret work, in a private project'],
  ] as const) {
    const issue = await run(alice())((tx) =>
      svc.issues.create(tx, alice(), WS, { projectId, title } as CreateIssue),
    )
    issueIn.set(projectId, issue.id)
  }
}, 180_000)

afterAll(async () => {
  await probe?.end().catch(() => undefined)
  await kernel?.stop().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

describe('what workspace search hands back', () => {
  it('indexed all three issues, so the assertions below are not measuring an empty index', () => {
    expect(indexed.size).toBe(3)
  })

  it('gives an admin every project they can open, private one included', async () => {
    const titles = await searchTitlesFor(alice())
    expect(titleOf('OPN')(titles)).toBe(true)
    expect(titleOf('OTH')(titles)).toBe(true)
    // Alice is a member of the private project, which is what admits her rather than her role.
    expect(titleOf('SEC')(titles)).toBe(true)
  })

  it('keeps a private project out of a member who is not on it', async () => {
    const titles = await searchTitlesFor(bob())
    expect(titleOf('OPN')(titles)).toBe(true)
    expect(titleOf('OTH')(titles)).toBe(true)
    expect(titleOf('SEC')(titles), "a private project's issue reached a non-member").toBe(false)
  })

  /**
   * The defect, as the person on the other end of it experienced it.
   *
   * Carol may open OPN and is refused OTH and SEC — asserted below rather than assumed — and until
   * the acl existed she was served all three titles by the palette.
   */
  it('hands a scoped guest nothing they cannot open', async () => {
    const titles = await searchTitlesFor(carol())
    expect(titles, 'a guest was served issues from projects they are refused').toEqual([])
  })

  it('refuses that same guest every project but the one they were given', async () => {
    // The half that makes the assertion above mean something: the guest is not merely missing hits,
    // they are missing hits for things they genuinely cannot open — and they can open OPN.
    await expect(
      run(carol())((tx) => svc.issues.get(tx, carol(), WS, issueIn.get(openProject)!)),
    ).resolves.toMatchObject({ projectId: openProject })
    await expect(
      run(carol())((tx) => svc.issues.get(tx, carol(), WS, issueIn.get(otherProject)!)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      run(carol())((tx) => svc.issues.get(tx, carol(), WS, issueIn.get(secretProject)!)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('follows a project that turns private, so an old reader loses the hit', async () => {
    await run(alice())((tx) =>
      svc.projects.update(tx, alice(), WS, otherProject, { visibility: 'private' } as never),
    )
    // The document is rewritten by the next mutation on the issue, which is what a project's
    // visibility change has to be followed by today.
    await run(alice())((tx) =>
      svc.issues.update(tx, alice(), WS, issueIn.get(otherProject)!, {
        title: 'Other work, now private',
      } as never),
    )
    const titles = await searchTitlesFor(bob())
    expect(titleOf('OTH')(titles), 'a member kept a hit on a project that went private').toBe(false)
    expect(titleOf('OTH')(await searchTitlesFor(alice())), 'the project member lost their own hit').toBe(true)
    await run(alice())((tx) =>
      svc.projects.update(tx, alice(), WS, otherProject, { visibility: 'workspace' } as never),
    )
  })
})

describe('the backfill for documents already indexed with a null acl', () => {
  it('overwrites them and stamps the workspace so it runs once', async () => {
    // Put the index back the way the module used to leave it.
    for (const [id, document] of indexed) indexed.set(id, { ...document, acl: null })
    await kernel.database.db
      .update(workspaces)
      .set({ searchAclBackfilledAt: null })
      .where(eq(workspaces.workspaceId, WS))
    expect(await searchTitlesFor(carol()), 'the stale state is not what it was').not.toEqual([])

    expect(await backfillSearchAcls(kernel)).toBe(1)
    expect(await searchTitlesFor(carol()), 'a stale null-acl document survived the backfill').toEqual([])

    const [row] = await kernel.database.db
      .select({ at: workspaces.searchAclBackfilledAt })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, WS))
    expect(row?.at).toBeInstanceOf(Date)
    // Stamped, so the next run is a query and no re-index.
    expect(await backfillSearchAcls(kernel)).toBe(0)
  })
})

describe('the two refusals a scoped caller met on the way', () => {
  it('lists views instead of failing on an empty project set', async () => {
    // An empty visible set used to compile to `project_id in ('')`, and Postgres answers
    // `invalid input syntax for type uuid: ""` (22P02) — a 500 from one of the first calls the
    // tracker sidebar makes, for anybody who can see no project at all.
    const stranger = principal(randomUUID(), 'guest')
    const nothing = await run(stranger)((tx) => svc.views.list(tx, stranger, WS))
    expect(nothing.filter((v) => v.projectId !== null)).toEqual([])

    // And the caller who can see one project still gets that project's views and no other's.
    const carolsViews = await run(carol())((tx) => svc.views.list(tx, carol(), WS))
    const projectIds = new Set(carolsViews.map((v) => v.projectId).filter(Boolean))
    expect(projectIds).toEqual(new Set([openProject]))
  })

  it('answers a project list rather than refusing it outright', async () => {
    const visible = await run(carol())((tx) => svc.projects.list(tx, carol(), WS, false))
    expect(visible.map((p) => p.key)).toEqual(['OPN'])

    // And a guest with no scope at all gets an empty list, not somebody else's projects.
    const stranger = principal(randomUUID(), 'guest')
    const none = await run(stranger)((tx) => svc.projects.list(tx, stranger, WS, false))
    expect(none).toEqual([])
  })
})
