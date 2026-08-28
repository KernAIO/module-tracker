---
'@kernhq/module-tracker': patch
---

Constrain every workspace-scoped query to its workspace, closing a class of cross-tenant IDOR.

**A bare `eq(table.id, input.something)` inside a workspace-scoped transaction is not scoped to
anything.** The transaction sets `app.workspace_id`, which is what row-level security reads — but
RLS is inert wherever the service connects as the Postgres superuser, and that is every deployment
today. So the predicate the query does not state is the only one there was. Four of these were
reachable with nothing but an id belonging to somebody else:

- `comments.create` wrote a caller-supplied `parentId` onto the new row and then incremented
  `reply_count` by `eq(comments.id, parentId)` — a reply filed in one workspace raised the count on
  a comment in another. The parent is now proved to be a comment on *this* issue in *this*
  workspace, and a foreign one answers **not found** rather than `forbidden`, which would confirm
  the row exists.
- `deleteTypeScheme` and `deleteWorkflowScheme` nulled `projects.type_scheme_id` /
  `workflow_scheme_id` for that id across **every** workspace while deleting only their own row, so
  one tenant could quietly unconfigure another's projects.
- `projects.memberIds` — reached over `kernel.call('tracker.projects.members')` — returned a
  project's member accounts for any workspace the caller named.
- `defaultAssignees` read `components` by the caller's ids with no workspace predicate, so a
  component whose default assignee is its lead put *that* lead on an issue created elsewhere.

`assertPlanningRefs`, `refreshMemberCount`, the SLA-breach sweep and the automation condition that
reads an issue by event payload are corrected the same way. Those were not exploitable — the id was
already proven, or both paths errored — but each would have started returning nothing the moment RLS
began to bite, which is a correctness bug worth finding now rather than in production.

`src/server/isolation.test.ts` proves the class is closed rather than the four cases: it seeds two
workspaces and asserts that an id belonging to A is neither readable nor mutable from B, at the
service layer *and* under an explicit `nosuperuser nobypassrls` Postgres role — the only role that
can tell a working policy from a missing one, since a superuser bypasses every policy and would pass
these assertions against tables carrying none.
