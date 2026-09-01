# @kernhq/module-tracker

Issue tracking for Kern: projects, work items, configurable workflows, a query language, planning
(cycles, milestones, versions), saved views, time tracking, reports, public intake and imports.

```ts
import trackerModule from '@kernhq/module-tracker/server'

await createKernel({ service: 'core', modules: [coreModule, trackerModule] })
```

| entry point | contains |
|---|---|
| `@kernhq/module-tracker/contract` | Zod models, the oRPC contract, events, permissions, notification types |
| `@kernhq/module-tracker/kql` | the query language: lexer, parser, validator, autocomplete (isomorphic — no database) |
| `@kernhq/module-tracker/server` | `defineServerModule`: Drizzle schema, migrations, router, procedures, jobs, search, resolvers |
| `@kernhq/module-tracker/migrations` | the SQL the kernel applies into `mod_tracker` |

Routes are mounted at `/api/tracker`; other modules reach it through `kernel.call('tracker.*')`.

---

## Domain model

### Projects

A **project** owns a key (`KRN`), a set of work item types, at least one workflow, and everything
planned inside it. Issue keys are allocated from a per-project counter row (`issue_counters`), so
`KRN-1`, `KRN-2`, … are gapless and concurrent creates serialise on one narrow row instead of the
project itself.

Visibility is `workspace` (anyone with `tracker.project.view`) or `private` (project members only).
Project membership carries a role (`admin` / `member` / `viewer`) and is the unit that per-project
permission bindings hang off.

A project is created from a **template** — `software`, `kanban`, `simple` or `blank` — which seeds a
workflow, the work item types and four built-in views. An existing project can be snapshotted into a
reusable `ProjectTemplate` and new projects created from it.

### Work items

| concept | what it is |
|---|---|
| **Work item type** | Epic / Story / Task / Bug / Sub-task. Carries a hierarchy `level` (`-1` sub-item, `0` standard, `1` epic, `2` initiative), an optional workflow and a field layout. |
| **Issue** | The work item itself. Key, type, title, rich-text description, status, priority, assignees, labels, components, versions, cycle, milestone, parent, estimate, dates, custom fields, watchers. |
| **Hierarchy** | `parentId` plus per-workspace `HierarchyRules` (`allowSkipLevels`, `allowSameLevel`, `maxSubItemDepth`). A child may never sit above its parent. |
| **Rank** | A base-62 fractional index. Reordering writes one row, never the rest of the list. |
| **Relations** | `blocks`, `relates`, `duplicates`, `clones` and their inverses. Stored as a pair of rows so either side lists its relations with one indexed lookup. |

`Issue.custom` is a JSONB bag keyed by custom-field key; `cf.<key>` addresses it in KQL, and a GIN
index makes those lookups cheap.

### Workflows

Statuses and transitions come from [`@kernhq/workflow`](../workflow). A transition can carry
**conditions** (offered only when they pass), **validators** (checked against what the user
submitted), **post-functions** (planned as intents the tracker executes: set a field, assign,
set a resolution, notify, call a webhook, create a sub-item) and an **approval** spec.

Which workflow an issue follows is resolved in this order:

```
work item type's explicit workflow
  → the project's workflow scheme (per-type mapping, else its default)
  → the project's default workflow
  → the workspace default workflow
```

Every status change writes an `issue_status_history` row with the time spent in the previous status.
That table is the source for the cumulative flow and cycle-time reports — the reports are never
recomputed from the current state.

### Planning

**Cycles** are numbered per project and move through `upcoming → active → completed`. Starting one
snapshots its scope so velocity can compare committed against completed; completing one rolls
unfinished work into the next cycle (or the backlog) and records the carry-over. **Milestones**,
**versions** and **components** are project-scoped; **labels** may be project- or workspace-scoped,
and labels sharing a `groupName` are mutually exclusive on an issue.

### Views

A view is a saved KQL query plus how to draw it (`list`, `board`, `calendar`, `timeline`,
`spreadsheet`), its grouping, ordering and visible columns. Visibility is `private`, `project` or
`workspace`; **pinning is per user**, so it lives in its own table and never mutates the shared row.

### Intake and email

Enabling intake mints a token. `GET /api/tracker/intake/{token}` and `POST` to the same path are the
only unauthenticated procedures: they are rate-limited, carry a honeypot field, and land in the
triage queue. Inbound email arrives from the mail module through
`kernel.call('tracker.issues.createFromEmail', …)` and threads onto an existing issue by
`In-Reply-To` / `References`, then by an issue key in the subject, before creating anything new.

### Time

A **worklog** adds to `timeSpentSec` and (optionally) reduces the remaining estimate. A user may have
one running **timer** per workspace; starting a second one stops the first, so time is never counted
twice.

---

## Tenancy

Every tenant table carries `workspace_id`, a composite index starting with it, and an RLS policy
generated by `rlsPolicySql` (see `migrations/0001_rls.sql`). All access goes through
`kernel.database.withWorkspace(workspaceId, …)`, which sets the `app.workspace_id` the policy reads —
outside it the tables are empty.

There is **no wildcard escape hatch**. Two tables therefore sit deliberately outside RLS because they
have to be readable before a tenant is known, and they contain nothing but ids:

- `workspaces` — which workspaces the tracker is active in, so the scheduled jobs can iterate them;
- `intake_tokens` — token → workspace, so an anonymous intake request can be routed at all.

---

## KQL — Kern Query Language

A JQL-like language over issues. It is parsed and validated in `@kernhq/module-tracker/kql` (which
runs in the browser too, for autocomplete and error underlining) and compiled to parameterised SQL
server-side.

### Grammar

```ebnf
query        = [ expr ] [ order-clause ] ;

expr         = or-expr ;
or-expr      = and-expr { "or" and-expr } ;
and-expr     = unary { "and" unary } ;
unary        = "not" unary
             | "(" expr ")"
             | comparison ;

comparison   = field ( operator value
                     | "in" "(" value { "," value } ")"
                     | "not" "in" "(" value { "," value } ")"
                     | "is" [ "not" ] "empty" ) ;

operator     = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" | "!~" ;

value        = string | number | date | reldate
             | "true" | "false" | "null"
             | bareword | function ;
function     = ident "(" [ value { "," value } ] ")" ;

order-clause = "order" "by" order-item { "," order-item } ;
order-item   = field [ "asc" | "desc" ] ;

field        = ident | "cf." ident ;          (* custom fields *)
ident        = letter { letter | digit | "_" | "." | "-" } ;
string       = '"' { char | '\' char } '"' | "'" { char | '\' char } "'" ;
number       = [ "+" | "-" ] digit { digit } [ "." digit { digit } ] ;
date         = 4digit "-" 2digit "-" 2digit [ ( "T" | " " ) time ] ;
reldate      = [ "+" | "-" ] digit { digit } ( "h" | "d" | "w" | "m" | "y" ) ;
```

Keywords (`and`, `or`, `not`, `in`, `is`, `empty`, `order`, `by`, `asc`, `desc`, `true`, `false`,
`null`) are case-insensitive; values are not. `and` binds tighter than `or`. An empty query matches
everything the caller may see.

### Operators by field kind

| kind | operators |
|---|---|
| text | `~` `!~` `=` `!=` `is empty` `is not empty` |
| enum (priority, statusCategory, select) | `=` `!=` `in` `not in` `<` `<=` `>` `>=` `is empty` `is not empty` |
| user (assignee, reporter, watcher) | `=` `!=` `in` `not in` `is empty` `is not empty` |
| number (estimate, timeSpent, `cf.*`) | `=` `!=` `<` `<=` `>` `>=` `in` `not in` `is empty` `is not empty` |
| date / datetime | `=` `!=` `<` `<=` `>` `>=` `is empty` `is not empty` |
| boolean (triage, archived) | `=` `!=` |
| ref (project, type, status, label, component, version, cycle, milestone, parent) | `=` `!=` `in` `not in` `is empty` `is not empty` |
| key | `=` `!=` `in` `not in` `~` `!~` |

`priority` compares by severity, not alphabetically: `priority > medium` matches `high` and `urgent`.
Array-valued fields (`assignee`, `label`, `component`, `version`, `watcher`) use membership: `=` and
`in` mean "contains any of", and `!=` / `not in` negate that.

### Functions

| function | meaning |
|---|---|
| `currentUser()` | the authenticated user |
| `now()` | the current instant |
| `startOfDay(n?)` `startOfWeek(n?)` `startOfMonth(n?)` | UTC boundaries, with an optional offset (`startOfWeek(-1)` = last week) |
| `activeCycle()` | the active cycle of each queried project |
| `openCycles()` | active and upcoming cycles |
| `membersOf("group")` | members of a workspace group |

Relative dates are written inline: `-7d`, `+2w`, `-3m`, `-1y`, `-6h`.

### Worked examples

```kql
-- everything assigned to me that is not finished, most urgent first
assignee = currentUser() and statusCategory != done order by priority desc, updated desc

-- this cycle's board, excluding the backlog
cycle = activeCycle() and statusCategory != backlog order by rank

-- bugs nobody has picked up, filed in the last week
type = bug and assignee is empty and created > -7d

-- overdue work that is neither done nor cancelled
due < startOfDay() and statusCategory not in (done, cancelled)

-- regressions that block something else
label = regression and status in ("In Progress", "In Review")

-- full-text across title and description
text ~ "connection reset" order by updated desc

-- a custom field, addressed by its key
cf.story_points >= 8 and cf.impact = high

-- negation and grouping
not (label = chore or label = docs) and priority >= high

-- issues with no estimate that are already in flight
estimate is empty and statusCategory = in_progress

-- one specific issue, or a family of keys
key = KRN-123
key ~ KRN
```

Names resolve to ids server-side: `label = regression`, `status = "In Progress"`,
`project = KRN`, `type = bug` all work, as do raw uuids. A name that matches nothing yields no
results rather than an error, so a renamed label degrades to an empty list instead of a failure.

`kql.parse` returns the AST, a normalised form (`printQuery`), errors with character spans, and
autocomplete suggestions; `kql.fields` lists every queryable field with its operators and known
values, including `cf.*` for the projects in scope.

---

## Events, jobs and procedures

**Events** (`tracker.issue.created/updated/status_changed/assigned/commented/deleted/archived/due`,
`tracker.cycle.started/completed`, `tracker.project.*`, `tracker.version.released`) are published on
every mutation, alongside a `kernel.realtime.change` so open clients update without a refresh.

**Jobs** run per workspace: `due-soon` (daily), `recurring` (every 15 minutes), `cycles` (hourly:
auto-start, auto-complete with roll-over, cycle-ending reminders, waking snoozed triage items), `sla`
(every 10 minutes) and `import` (queued).

**Procedures** for other modules: `tracker.issues.get`, `.getMany`, `.create`, `.update`,
`.createFromEmail`, `.addComment`, `tracker.projects.get`, `.members`, `tracker.collab.access`. They
are service-to-service and reject end-user principals.

---

## Development

```bash
pnpm --filter @kernhq/module-tracker test        # unit + integration (needs Postgres 18)
pnpm --filter @kernhq/module-tracker typecheck
pnpm --filter @kernhq/module-tracker db:generate # after changing src/server/schema.ts
```

Integration tests create their own scratch database from `DATABASE_URL` (default
`postgres://kern:kern@localhost:5432/kern`) and drop it afterwards. After regenerating the schema,
re-generate the RLS migration for any new tenant table — it is derived from `TENANT_TABLES` with
`rlsPolicySql`, and generated Drizzle SQL never contains RLS.

`src/contract/permissions.test.ts` pins the permission matrix: which built-in role holds which
tracker permission by default, with the kernel's guest ⊆ member ⊆ admin ⊆ owner cascade already
applied. Change a `defaultRoles` entry in `src/contract/permissions.ts` and the test fails, naming
every row that moved. Confirm the change is intended, then update the `BLESSED` table in the same
commit. The helpers come from `@kernhq/testing`, so other modules can copy the pattern.
