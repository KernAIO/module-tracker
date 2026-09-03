---
'@kernhq/module-tracker': patch
---

The tracker's dashboard widgets show their titles, descriptions and settings labels again. They
were looked up under a `common.` prefix the shared bundle does not carry, so the widget picker and
the settings sheet showed raw message keys.
