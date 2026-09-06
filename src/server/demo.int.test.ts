import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedTrackerDemo } from './demo.js'
import { trackerModule } from './index.js'
import { comments, cycles, issues, labels, projects } from './schema.js'

/**
 * The demo seeder, run against a real Postgres.
 *
 * A seeder that compiles proves nothing: it writes through six services, each with its own
 * constraints, and the only way to know it works is to let the SQL reach a database. Running it
 * twice is the second half — delivery is at-least-once, so a second event must not double the
 * workspace's contents.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_tracker_demo_${Date.now().toString(36)}`

let kernel: Kernel
let admin: pg.Client

const WS = randomUUID()
const OWNER = randomUUID()

const actor = (): Principal =>
  ({
    kind: 'service',
    userId: OWNER,
    email: null,
    name: 'service:test',
    locale: 'en',
    instanceAdmin: true,
    service: 'test',
    memberships: [],
    permissionVersion: 0,
  }) as unknown as Principal

const seed = () =>
  seedTrackerDemo({ kernel, workspaceId: WS, actorId: OWNER, actor: actor(), now: new Date() })

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'tracker-demo-test',
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
  kernel.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'settings.getModule': { handler: async () => ({}) },
    'modules.isEnabled': { handler: async () => true },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'workspaces.members': { handler: async () => [] },
  })
  await kernel.start()
  await trackerModule.onWorkspaceEnabled?.(WS, kernel)
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

describe('the demo seeder', () => {
  it('fills an empty workspace', async () => {
    const summary = await seed()
    expect(summary.skipped).toBeFalsy()

    const rows = await kernel.database.withWorkspace(WS, async (tx) => ({
      projects: await tx.select().from(projects).where(eq(projects.workspaceId, WS)),
      issues: await tx.select().from(issues).where(eq(issues.workspaceId, WS)),
      labels: await tx.select().from(labels).where(eq(labels.workspaceId, WS)),
      cycles: await tx.select().from(cycles).where(eq(cycles.workspaceId, WS)),
      comments: await tx.select().from(comments).where(eq(comments.workspaceId, WS)),
    }))

    expect(rows.projects.map((p) => p.key).sort()).toEqual(['APP', 'SUP', 'WEB'])
    expect(rows.issues.length).toBe(summary.created?.issues)
    expect(rows.issues.length).toBeGreaterThan(20)
    // The seeder's ten, plus whatever each project template installs — so this asserts the ten are
    // there rather than pinning a total that moves whenever a template gains a label.
    const labelNames = new Set(rows.labels.map((l) => l.name))
    for (const name of ['bug', 'feature request', 'escalation', 'website', 'mobile', 'performance'])
      expect(labelNames.has(name)).toBe(true)
    expect(rows.cycles.length).toBe(4)
    expect(rows.comments.length).toBeGreaterThan(0)

    // Every issue got a key from the project's counter, which a hand-written row would not have.
    expect(rows.issues.every((i) => /^(WEB|APP|SUP)-\d+$/.test(i.key))).toBe(true)
    // The board has something in every column: a demo where everything is in "backlog" shows one
    // column working and says nothing about the rest.
    const categories = new Set(rows.issues.map((i) => i.statusCategory))
    expect(categories.has('backlog')).toBe(true)
    expect(categories.has('in_progress')).toBe(true)
    expect(categories.has('done')).toBe(true)
    expect(categories.has('todo')).toBe(true)
    /*
     * The seeder's own count of moves it made, asserted so a silently-skipped transition cannot
     * pass as a working board again — the first run reported success with all twenty-five issues in
     * `backlog`, because the seed named categories (`started`, `completed`) that are not in
     * `StatusCategory` and every lookup missed.
     *
     * Thirteen rather than eighteen because five seeds ask for `todo`, which is the category every
     * workflow here starts in: those need no move, and counting one would be counting a no-op.
     */
    expect(summary.created?.moved).toBe(13)
    // Anything scheduled is in the *current* cycle, not an ended one.
    expect(rows.issues.filter((i) => i.cycleId).length).toBeGreaterThan(5)
  })

  /*
   * The case the first version of these seeders got wrong, and the reason it is a test rather than
   * a comment: the emptiness guard left `workspace_id` to row-level security, so on any database
   * whose owner can bypass a policy it saw the *previous* workspace's projects and skipped. Every
   * workspace after the first on such an instance was created empty, reporting success. This test
   * database is exactly that kind — it connects as a superuser — so a second workspace here is the
   * cheapest possible reproduction.
   */
  it('fills a second workspace in the same database', async () => {
    const other = randomUUID()
    const summary = await seedTrackerDemo({
      kernel,
      workspaceId: other,
      actorId: OWNER,
      actor: actor(),
      now: new Date(),
    })
    expect(summary.skipped).toBeFalsy()
    const rows = await kernel.database.withWorkspace(other, (tx) =>
      tx.select().from(projects).where(eq(projects.workspaceId, other)),
    )
    expect(rows.length).toBe(3)
  })

  it('leaves a workspace that already holds something alone', async () => {
    const before = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(issues).where(eq(issues.workspaceId, WS)),
    )
    expect((await seed()).skipped).toBe(true)
    const after = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(issues).where(eq(issues.workspaceId, WS)),
    )
    expect(after.length).toBe(before.length)
  })
})
