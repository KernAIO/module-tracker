---
'@kernhq/module-tracker': patch
---

Re-index a project's issues when who may read it changes, and make the acl sweep come round again.

The search acl is denormalised onto every issue document, and only a mutation on the issue itself
rewrote it. So a project turned private, and a member removed from a private one, left the old
readers holding the key, title and indexed description of every issue in that project until somebody
happened to edit one — `issues.get` answered FORBIDDEN while workspace search still returned the
title. `projects.update` (on a visibility change), `addMembers`, `removeMember` and the
`core.member.removed` subscription now re-index the project. The same call fixes the other
direction: a member added to a private project could not find its issues at all.

The `search-acl` job stamped each workspace once and never revisited it, so it could only repair the
acls that were wrong the day it first ran. It now takes the oldest stamps first — never swept
before the rest — and re-stamps, sweeping a workspace at most once a day.

Still open, and stated in `services/search.ts`: a **project-scoped deny binding fails open**. A deny
is subtractive and an acl is a set overlap, so a caller denied one project keeps the hit while
`issues.get` refuses them. Closing it needs core to match a hit against the module's visible set, or
to apply denies alongside `subjects`.
