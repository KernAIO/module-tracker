# @kernhq/module-tracker

## 0.3.1

### Patch Changes

- 5ba65a2: Let an approval addressed to a group or a role be granted.

  `resolveSubject` returned nobody for `group` and `role` subjects, so an approval addressed to either
  could never reach `minApprovals` — the transition was stuck for good, with no error to explain it.

  Core's member list already carries each member's `groupIds` and `roleIds`, so the tracker expands
  them from that. A role subject matches a custom role id or a built-in role name (`owner`, `admin`,
  `member`, `guest`). If core cannot answer, the transition now fails loudly rather than quietly
  resolving to an approval nobody can grant.

## 0.3.0

### Minor Changes

- 2c72308: Let a file arrive with a comment.

  `attachments.add` accepts an optional `commentId`, and `Attachment` carries it. A file belongs to
  the issue and _optionally_ to the comment that introduced it, so the issue keeps listing every
  attachment while a comment can show its own.

  Attaching to a comment requires `tracker.issue.comment` rather than the edit permission — somebody
  who may reply but not edit must still be able to attach a screenshot to their reply — and the author
  of a comment may remove the files that arrived with it, the same way they own its text.

## 0.2.1

### Patch Changes

- ac8cab0: Export the field-layout types from `@kernhq/module-tracker/client`.

  `ResolvedLayout`, `ResolvedField`, `FieldLayoutItem`, `ProjectTemplateBody`, `ProjectTemplateId` and
  `SystemFieldId` were added to the contract but not to the client's type surface, so an interface
  could call `types.layout` and had no way to name what came back.

## 0.2.0

### Minor Changes

- d4e3778: Make the per-work-item-type field layout real, and validate custom values on every write.

  `WorkItemType.fieldLayout` has been stored since the type existed and was read by nothing. It is now
  resolved: `types.layout` returns the fields of one type in one project, ordered, labelled and split
  into `main` and `sidebar`, with system fields and custom fields in one list addressed by the same
  `cf.<key>` convention that KQL and view columns already use.

  Two rules keep it from surprising anyone. An **empty layout means the default layout** — every type
  starts with `fieldLayout: []`, so anything else would blank every existing issue panel. And a field
  the layout does not mention is **appended, not hidden**, so a newly created field appears instead of
  looking like it failed to save. `title`, `status` and `type` can never be hidden.

  Custom values are now checked against their field definition on **update** as well as create: a
  `select` refuses a value that is not one of its options, a `number` respects `min`/`max`/`precision`,
  a `url` refuses anything but http and https, and a key that no field defines is an error rather than
  a silent write. A required field is enforced for `app` and `api`; for `email`, `intake`, `import` and
  `automation` the gap is logged and the issue is still created, because a customer's email must not
  bounce because the workspace made a field mandatory.

  Transition screens now save what they collect. The values were passed to the rule engine and then
  dropped, so a screen appeared to work only when a `field.set` post-function repeated the value. Only
  the fields a screen declares are applied — `tracker.issue.transition` is narrower than
  `tracker.issue.update`.

  `searchable` reaches the search index for the first time, and a CSV import converts a cell to its
  field's type instead of importing every column as text.

  **Breaking:** `FieldScheme` and `fields.schemes.*` are removed, along with `Project.fieldSchemeId`.
  A project gated its custom fields twice — once by scheme, once by layout — and a field hidden by
  either was impossible to explain. The layout is the more capable of the two. `TypeScheme` and
  `WorkflowScheme` are unaffected. Migration `0003` drops the table.

  Also fixed: `workflows.create` and `workflows.update` validated without the rule registry and so
  accepted definitions `workflows.validate` rejected; removing a status consulted issues across the
  whole workspace rather than the types the workflow governs; a `relation` field compiled as scalar
  text in KQL and never matched; and two partial unique indexes let two field definitions share one
  key, and therefore one value. Migration `0002` replaces them with one constraint and refuses to run
  where a collision already exists.

## 0.1.3

### Patch Changes

- 0436392: Scope component and label issue counts to the workspace.

  `arrayCounts` took a `workspaceId` and never used it, so the number beside a component or label
  counted matching issues across every workspace in the schema. Row-level security hides that in a
  deployment, but not from a role that can bypass it — which is exactly why the other queries here
  carry an explicit `workspace_id` predicate. This one now does too.

## 0.1.2

### Patch Changes

- 90f5fbc: Ship the sources the published client imports, and stop advertising a client that does not exist.

  0.1.1 fixed the unresolvable client by having it import its own package's entry points. That works
  for a consumer but not for the module repository itself, where the packages are type-checked before
  they are built — the entry points resolve to `dist`, which does not exist yet. The client goes back
  to relative imports and the tarball now carries `src/contract` (and `src/kql` for the tracker),
  which is what those imports point at.

  `@kernhq/module-chat` declared a `./client` export pointing at a file that was never written, so
  importing it always failed. The export is gone until the chat client lands.

  `pnpm check:pack` packs each module for real and walks every import from the published client entry,
  so neither can come back unnoticed.

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
