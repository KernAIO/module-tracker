---
'@kernhq/module-tracker': patch
---

Make every migration survive being applied twice.

`create policy` and `add constraint` have no `if not exists` at all, and `create table` and
`create index` do not get one by default — so a replay throws. A module migration that throws takes
down the **whole host service**, not just its own module; `core` hosts five, so one module's replay
is an outage for every other module in the process.

A replay is not hypothetical, and this change causes one: drizzle keys applied migrations by content
hash, so editing these files makes them all run again against schemas that already have their
objects. That is exactly the case they now survive.

`src/server/migrations.test.ts` applies the whole folder to a database created from nothing, applies
it a second time, and asserts each policy exists once and that RLS is forced on every table carrying
one. Calling `migrateModule` twice does not test this — the second call reads `__migrations`, sees
the work is done and returns.
