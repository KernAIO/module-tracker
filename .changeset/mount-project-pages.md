---
'@kernhq/module-tracker': patch
---

Mount the project pages the sidebar already links to: /tracker/projects/:key
and /tracker/projects/:key/:section. The screens moved into this package
without their routes, so Components, Milestones, Cycles and Templates were
reachable only as 404s.
