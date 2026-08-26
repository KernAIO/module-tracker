---
'@kernhq/module-tracker': patch
---

fix: raise @kernhq ranges to what is published

A caret on 0.x never crosses a minor, so `@kernhq/ui: ^0.8.0` and `@kernhq/contracts: ^0.5.1` could not install the published 0.9.0 and 0.6.1. Raised both to `^0.9.0` and `^0.6.1`.
