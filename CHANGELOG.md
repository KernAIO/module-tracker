# @kernhq/module-tracker

## 0.1.1

### Patch Changes

- b6e9f16: Make the published client source resolvable.

  A module ships `src/client` as source so consumers build the Svelte components with their own
  toolchain, but that source imported `../contract/…` and `../kql/…` — paths under `src/` that the
  tarball does not contain. It worked in the development workspace, where the whole repository is
  linked, and failed in any real install with `Could not resolve '../kql/ast.js'`. The client now
  refers to its own package's entry points, the way any other consumer would, and those entries carry
  a `default` condition so resolvers that do not ask for `import` can find them too.

- b6e9f16: Authorise issue templates, recurring rules and watcher changes.

  Templates and recurring rules are project configuration — they decide what everyone else's issues
  look like — but any member who could see a project could create, rewrite or delete them. They now
  take `tracker.project.manage`, at project scope when they belong to a project and at workspace scope
  when they are shared, and listing templates only returns the ones the caller can reach.

  Adding or removing _other people_ from an issue's watchers decides whose inbox it lands in, so it
  takes the new `tracker.issue.manage_watchers` permission. Watching or unwatching yourself still only
  needs to be able to see the issue.
