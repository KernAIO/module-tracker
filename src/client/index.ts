/**
 * Tracker client entry.
 *
 * The pieces a host application needs to talk to the tracker and to render it the way `DESIGN.md`
 * describes, with no framework in them: a typed API client, the presentation rules for statuses,
 * priorities and due dates, grouping for the list and the board, fractional ranks for drag and drop,
 * and a KQL reader for the query box.
 *
 * The Svelte views themselves live in the host app (`repos/shell/src/lib/modules/tracker`) for now:
 * the shell renders module pages as real SvelteKit routes rather than through `ClientModule.routes`,
 * so shipping components from here would have nowhere to be mounted.
 */

export { createTrackerClient, type TrackerApi } from './api.js'
export { __setTrackerApi, getTrackerApi } from './api-instance.js'
export {
  type DueTone,
  daysUntil,
  dueTone,
  formatDuration,
  PRIORITY_BAR_GEOMETRY,
  PRIORITY_GROUP_ORDER,
  priorityBars,
  STATUS_CATEGORY_ORDER,
  type StatusStyle,
  type StatusVisual,
  statusStyle,
} from './format.js'
export {
  type GroupContext,
  type GroupKey,
  groupIssues,
  groupKeysOf,
  groupOrder,
  type IssueGroup,
} from './group.js'
export { type TrackerMessageKey, t, trackerMessageBundles } from './i18n.js'
export {
  customKqlField,
  type KqlComparison,
  type KqlExpr,
  type KqlField,
  type KqlOp,
  type KqlOrder,
  type KqlQuery,
  type KqlValue,
  operatorsFor,
  type ParsedKql,
  type ParseOptions,
  parseKql,
  type Span,
  SYSTEM_FIELDS,
} from './kql.js'
export { trackerClientModule, trackerClientModule as default } from './module.js'
/**
 * The public intake form, exported as a component.
 *
 * It is the one tracker screen that is *not* inside a workspace: somebody outside the organisation
 * opens `/request/<token>` with no session at all, so the shell mounts it as an app route rather
 * than through the module router, and needs the component by name.
 */
export { default as IntakePage } from './pages/IntakePage.svelte'
export { canTracker, TRACKER_PERMISSIONS, type TrackerPermission } from './permissions.js'
export {
  byRank,
  initialRank,
  isValidRank,
  rankBetween,
  rankForIndex,
  rankSequence,
} from './rank.js'
export { describeApprovers, describeRule, type RuleDescription } from './rules.js'
export type * from './types.js'
