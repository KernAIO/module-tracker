import type { StatusCategory } from '@kernhq/workflow'
import type { GroupBy, Issue, Priority } from '../contract/models.js'
import { PRIORITY_GROUP_ORDER, STATUS_CATEGORY_ORDER } from './format.js'
import { byRank } from './rank.js'

/**
 * Turning a flat list of issues into the grouped list and board the design draws.
 *
 * Kept separate from the components because the rules have edges worth testing: multi-valued fields
 * (assignees, labels) put an issue in every group it belongs to, unassigned work still needs a
 * group, empty groups are hidden, and the group order is prescribed per grouping (DESIGN.md 3.2).
 */

/** `null` is the "no value" group: Unassigned, No label, No cycle and so on. */
export type GroupKey = string | null

export interface IssueGroup<T> {
  key: GroupKey
  items: T[]
  /** sum of estimates, `null` when nothing in the group is estimated */
  estimate: number | null
}

/** Everything grouping needs to know that does not live on the issue itself. */
export interface GroupContext {
  /** display order of a status inside the board and list (workflow order) */
  statusOrder(statusId: string): number
  statusCategory(statusId: string): StatusCategory
  /** display order for the remaining reference fields; unknown ids sort last */
  order?(groupBy: GroupBy, key: string): number
}

type Groupable = Pick<
  Issue,
  | 'statusId'
  | 'statusCategory'
  | 'priority'
  | 'assigneeIds'
  | 'labelIds'
  | 'componentIds'
  | 'versionIds'
  | 'typeId'
  | 'cycleId'
  | 'milestoneId'
  | 'projectId'
  | 'parentId'
  | 'dueDate'
  | 'createdAt'
  | 'estimate'
  | 'rank'
>

/** Every group an issue belongs to under `groupBy`. Multi-valued fields yield more than one. */
export function groupKeysOf(issue: Groupable, groupBy: GroupBy): GroupKey[] {
  switch (groupBy) {
    case 'status':
      return [issue.statusId]
    case 'statusCategory':
      return [issue.statusCategory]
    case 'priority':
      return [issue.priority]
    case 'type':
      return [issue.typeId]
    case 'project':
      return [issue.projectId]
    case 'assignee':
      return issue.assigneeIds.length ? [...issue.assigneeIds] : [null]
    case 'label':
      return issue.labelIds.length ? [...issue.labelIds] : [null]
    case 'component':
      return issue.componentIds.length ? [...issue.componentIds] : [null]
    case 'version':
      return issue.versionIds.length ? [...issue.versionIds] : [null]
    case 'cycle':
      return [issue.cycleId]
    case 'milestone':
      return [issue.milestoneId]
    case 'parent':
      return [issue.parentId]
    case 'dueDate':
      return [issue.dueDate]
    case 'createdAt':
      return [issue.createdAt.slice(0, 10)]
    default:
      return [null]
  }
}

/** Sort weight for a group heading. Lower comes first; the "no value" group always goes last. */
export function groupOrder(key: GroupKey, groupBy: GroupBy, ctx: GroupContext): number {
  if (key === null) return Number.MAX_SAFE_INTEGER
  switch (groupBy) {
    case 'status':
      return STATUS_CATEGORY_ORDER[ctx.statusCategory(key)] * 1000 + ctx.statusOrder(key)
    case 'statusCategory':
      return STATUS_CATEGORY_ORDER[key as StatusCategory] ?? 900
    case 'priority': {
      const i = PRIORITY_GROUP_ORDER.indexOf(key as Priority)
      return i < 0 ? 900 : i
    }
    default:
      return ctx.order?.(groupBy, key) ?? 0
  }
}

/**
 * Group and order issues for the list and the board.
 *
 * Groups with no rows are dropped, because the design never shows an empty heading. The exception is
 * `alwaysShow`, which is how a board keeps an empty column you can still drop a card into.
 */
export function groupIssues<T extends Groupable>(
  issues: readonly T[],
  groupBy: GroupBy,
  ctx: GroupContext,
  opts: { alwaysShow?: readonly GroupKey[]; compare?: (a: T, b: T) => number } = {},
): Array<IssueGroup<T>> {
  const compare = opts.compare ?? byRank
  const buckets = new Map<string, IssueGroup<T>>()
  const keyId = (k: GroupKey) => (k === null ? ' none' : k)

  for (const key of opts.alwaysShow ?? []) {
    buckets.set(keyId(key), { key, items: [], estimate: null })
  }
  for (const issue of issues) {
    for (const key of groupKeysOf(issue, groupBy)) {
      const id = keyId(key)
      let bucket = buckets.get(id)
      if (!bucket) {
        bucket = { key, items: [], estimate: null }
        buckets.set(id, bucket)
      }
      bucket.items.push(issue)
    }
  }

  const always = new Set((opts.alwaysShow ?? []).map(keyId))
  return [...buckets.values()]
    .filter((g) => g.items.length > 0 || always.has(keyId(g.key)))
    .map((g) => {
      g.items.sort(compare)
      const estimates = g.items.map((i) => i.estimate).filter((e): e is number => typeof e === 'number')
      g.estimate = estimates.length ? estimates.reduce((a, b) => a + b, 0) : null
      return g
    })
    .sort((a, b) => {
      const d = groupOrder(a.key, groupBy, ctx) - groupOrder(b.key, groupBy, ctx)
      return d !== 0 ? d : String(a.key ?? '').localeCompare(String(b.key ?? ''))
    })
}
