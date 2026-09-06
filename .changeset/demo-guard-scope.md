---
'@kernhq/module-tracker': patch
---

Scope the demo seeder's emptiness guard to the workspace.

The guard left `workspace_id` to row-level security. The transaction is bound to the workspace, so
on a correctly-configured instance RLS scopes it — and on any database whose owner can bypass a
policy it does not, so the guard saw the *previous* workspace's rows and reported an empty workspace
as used. Measured on a development database: the first workspace filled, and every one after it was
created empty while the log said "workspace not empty". The predicate is written out now, and each
seeder's test seeds a second workspace in the same database, which is what reproduces it.
