---
'@kernhq/module-tracker': patch
---

Declare the framework this is built against: `@kernhq/contracts@0.7.0`.

`^0.6.1` cannot install 0.7.0 — a caret on 0.x never crosses a minor — so a host resolving this
module from the registry would be told it needs a contracts two releases behind the one every
service now runs. Typechecked against 0.7.0 in the workspace before the range moved, which is the
only order that means anything: the umbrella pins contracts to `workspace:*`, so raising a range
first and compiling second compiles against the old copy and proves nothing.

The lockfile is refreshed in the same change, because `--frozen-lockfile` compares specifiers and
a range edit alone fails install before anything is built.
