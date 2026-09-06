---
'@kernhq/module-tracker': minor
---

Give indexed issues a real search `acl`, and unblock the three refusals a project-scoped caller met.

Issues were indexed with `acl: null`, which core reads as "visible to everybody in this workspace",
so workspace search served every member the key, title and indexed description of every issue in
every project — including projects they were refused when they opened one. Documents now carry the
readers of their project, and a `search-acl` job re-indexes workspaces whose documents predate this.

Alongside it: `views.list` no longer fails with a raw Postgres error when the caller can see no
project, `projects.list` answers an empty list instead of 403 for a caller without the
workspace-scoped permission, and the URL in every tracker notification and search hit now opens the
issue rather than the issue list.

`IssueService.reindex` takes the caller's transaction as its first argument.
