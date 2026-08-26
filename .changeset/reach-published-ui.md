---
'@kernhq/module-tracker': patch
---

Reach the published framework, and refresh the lockfile that the range edit invalidated.

`^0.9.0` cannot install `@kernhq/ui@0.10.0` — a caret on 0.x never crosses a minor — so a consumer
installing this module from the registry resolved a framework it was not built against. Raising the
range then leaves the committed `pnpm-lock.yaml` out of date with the manifest, and
`--frozen-lockfile` compares specifiers, so the next publish dies at install having built nothing.
Both halves are here because one without the other is not a fix.

`scripts/check-ranges.mjs` now checks the lockfile as well, so the second half cannot be forgotten
again — and checks this package's hosts against its peers, which `pnpm install` does not: pnpm 10
resolved a `^0.6.1` peer against `contracts@0.5.2` and exited 0 without a warning.
