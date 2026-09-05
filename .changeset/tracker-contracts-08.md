---
'@kernhq/module-tracker': patch
---

Peer `@kernhq/contracts@^0.8.0`, which adds `archivedAt` to `WorkspaceSummary`. A caret on 0.x does
not cross a minor, so the previous `^0.7.0` could not reach it.
