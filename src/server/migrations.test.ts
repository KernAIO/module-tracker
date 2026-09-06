/**
 * Every migration must survive being applied twice.
 *
 * Not tidiness. `create policy` and `add constraint` have no `if not exists` at all, and
 * `create table` / `create index` do not get one by default — so a replay throws, and a module
 * migration that throws takes down the **whole host service**, not just its own module. `core`
 * hosts five.
 *
 * A replay is not hypothetical: drizzle keys applied migrations by content hash, so regenerating the
 * journal — which happens whenever somebody re-runs `db:generate` — makes every file run again
 * against a schema that already has its objects.
 *
 * Calling `migrateModule` twice does not test this. The second call reads `__migrations`, sees the
 * work is done and returns. Only replaying the SQL itself reaches the failure.
 *
 * Idempotent is also not the same as effective: a replayed `create table if not exists` reports
 * success and changes nothing, so a rewritten migration silently leaves an existing schema as it
 * was. That is a different problem and it needs `drop schema mod_tracker cascade`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_TABLES } from './schema.js'

const BASE = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB = `kern_tracker_migrations_${Date.now().toString(36)}`
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

/**
 * The tables in `mod_tracker` that carry `workspace_id` and deliberately have no policy, each with
 * the reason and the code that keeps them safe.
 *
 * This list is the whole point of the assertion below. Adding a name to it is a decision somebody
 * records, not a way to make a red test green: a table that belongs here is one whose isolation is
 * enforced somewhere a reader can go and look at.
 */
const UNSECURED_BY_DESIGN: Record<string, string> = {
  workspaces:
    'the registry of workspaces the tracker is active in — ids and a timestamp, no tenant content. ' +
    '`activeWorkspaces()` in src/server/index.ts enumerates it from the scheduled jobs, which are ' +
    'woken by a clock and therefore have no workspace bound by construction.',
  intake_tokens:
    'the public intake form and inbound email arrive carrying nothing but a token, so ' +
    '`IntakeService.resolveToken` (src/server/services/intake.ts) has to resolve it to a workspace ' +
    'before an RLS-bound transaction can be opened. Holds no tenant content.',
}

let admin: pg.Client
let client: pg.Client

const files = () =>
  readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

/** Apply every migration in order, the way the kernel's runner does — statement by statement. */
async function applyAll(): Promise<string[]> {
  const failures: string[] = []
  for (const file of files()) {
    const sql = readFileSync(join(DIR, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue
      try {
        await client.query(statement)
      } catch (err) {
        failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return failures
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`create database "${DB}"`)
  const url = new URL(BASE)
  url.pathname = `/${DB}`
  client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  // The kernel creates the schema before running a module's migrations.
  await client.query('create schema if not exists mod_tracker')
}, 120_000)

afterAll(async () => {
  await client?.end().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB}" with (force)`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

describe('the migrations', () => {
  it('apply to a schema created from nothing', async () => {
    expect(
      await applyAll(),
      'a migration that has only ever run against your dev database has not been tested',
    ).toEqual([])
  })

  it('apply again without throwing, so a replay is a no-op and not a boot failure', async () => {
    expect(
      await applyAll(),
      'a module migration that throws takes down every module in the host service, not only its own',
    ).toEqual([])
  })

  it('leaves each policy defined once, not once per replay', async () => {
    await applyAll()
    const { rows } = await client.query<{ tablename: string; policyname: string; n: string }>(
      `select tablename, policyname, count(*)::text as n from pg_policies
       where schemaname = 'mod_tracker' group by tablename, policyname order by tablename`,
    )
    for (const row of rows)
      expect(Number(row.n), `${row.tablename}.${row.policyname} exists ${row.n} times`).toBe(1)
  })

  it('forces row-level security on every table it wrote a policy for', async () => {
    const { rows } = await client.query<{ relname: string; forced: boolean; enabled: boolean }>(
      `select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
         from pg_class c
        where c.relnamespace = 'mod_tracker'::regnamespace
          and c.relkind = 'r'
          and exists (select 1 from pg_policies p
                       where p.schemaname = 'mod_tracker' and p.tablename = c.relname)
        order by c.relname`,
    )
    expect(rows.length, 'no table has a policy, so this assertion proves nothing').toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.enabled, `${row.relname} has RLS off`).toBe(true)
      // Without force, the table owner bypasses the policy — and the owner is the service's role.
      expect(row.forced, `${row.relname} does not force RLS`).toBe(true)
    }
  })

  /**
   * The question the test above cannot ask.
   *
   * It selects the tables that already *have* a policy and checks they force it — so a table with
   * no policy at all is never looked at, and passes by being invisible. That is not a hypothetical
   * gap: it is how twelve unsecured tenant tables across the first-party modules went uncounted
   * while every module's migration test was green (measured on a database created from nothing,
   * 2026-09-06).
   *
   * So this asks the catalogue the other way round: every table in `mod_tracker` carrying a
   * `workspace_id` column must have RLS enabled, forced, and at least one policy — unless it is
   * named in `UNSECURED_BY_DESIGN` above with the code that isolates it instead.
   *
   * `relkind in ('r','p')` on purpose: a partitioned parent is `'p'`, and an `'r'`-only query
   * silently skips it.
   */
  it('secures every table that carries a workspace column, or names it as an exception', async () => {
    const { rows } = await client.query<{
      relname: string
      enabled: boolean
      forced: boolean
      policies: number
      partition: boolean
    }>(
      `select c.relname,
              c.relrowsecurity as enabled,
              c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
              c.relispartition as partition
         from pg_class c
        where c.relnamespace = 'mod_tracker'::regnamespace
          and c.relkind in ('r', 'p')
          and exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped)
        order by c.relname`,
    )
    expect(rows.length, 'no tenant table found at all — the schema did not build').toBeGreaterThan(0)

    const unsecured = rows.filter((r) => !r.enabled || !r.forced || r.policies === 0).map((r) => r.relname)
    expect(
      unsecured.filter((t) => !(t in UNSECURED_BY_DESIGN)),
      'carries workspace_id, has no forced policy, and is not declared an exception',
    ).toEqual([])

    // The list is only worth trusting if it decays: an exception that has since been given a policy
    // has to leave, or the next reader believes a table is unprotected when it is not.
    expect(
      Object.keys(UNSECURED_BY_DESIGN).filter((t) => !unsecured.includes(t)),
      'declared an exception and now secured — delete the entry',
    ).toEqual([])

    // And a table nobody has classified at all is the thing that started this: it must be named
    // either as a tenant table or as an exception, so adding one is a decision rather than an
    // omission. Partitions are excluded — `TENANT_TABLES` names the parent, not the months.
    const classified = new Set<string>([...TENANT_TABLES, ...Object.keys(UNSECURED_BY_DESIGN)])
    expect(
      rows.filter((r) => !r.partition && !classified.has(r.relname)).map((r) => r.relname),
      'carries workspace_id but is in neither TENANT_TABLES nor UNSECURED_BY_DESIGN',
    ).toEqual([])
  })
})
