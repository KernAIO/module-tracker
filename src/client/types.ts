/**
 * The contract types a tracker UI works with, re-exported for hosts.
 *
 * `export type *` rather than a hand-kept list. Types only: the form is erased at compile time, so
 * importing this never pulls the zod schemas — or the server contract — into a browser bundle.
 * Anything that needs the schemas at runtime should import `@kernhq/module-tracker/contract`.
 *
 * It used to be an allowlist, which meant every interface that reached for one more model needed a
 * publish of this package before it could name what it was already receiving. The list guarded
 * nothing: the types it omitted were as erased as the ones it named.
 */

export type * from '../contract/index.js'
