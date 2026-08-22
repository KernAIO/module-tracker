import { describe, expect, it } from 'vitest'
import { groupIssues, groupKeysOf } from './group.js'

/**
 * Grouping by a custom field.
 *
 * The built-in keys are covered by the view tests; this is about `cf.<key>`, where the value lives
 * in `issue.custom` and may be a single value or several.
 */
const issue = (custom: Record<string, unknown>, id = 'i1') =>
  ({
    id,
    statusId: 'todo',
    statusCategory: 'todo' as const,
    priority: 'none' as const,
    assigneeIds: [],
    labelIds: [],
    componentIds: [],
    versionIds: [],
    typeId: 't1',
    cycleId: null,
    milestoneId: null,
    projectId: 'p1',
    parentId: null,
    dueDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    estimate: null,
    rank: 'a0',
    custom,
  }) as never

const ctx = { statusOrder: () => 0, statusCategory: () => 'todo' as const }

describe('groupKeysOf with a custom field', () => {
  it('reads a single value', () => {
    expect(groupKeysOf(issue({ severity: 's1' }), 'cf.severity')).toEqual(['s1'])
  })

  it('puts a multi-valued field in every group it names', () => {
    expect(groupKeysOf(issue({ squad: ['core', 'growth'] }), 'cf.squad')).toEqual(['core', 'growth'])
  })

  it('groups under nothing when the field is empty, absent or an empty list', () => {
    expect(groupKeysOf(issue({}), 'cf.severity')).toEqual([null])
    expect(groupKeysOf(issue({ severity: '' }), 'cf.severity')).toEqual([null])
    expect(groupKeysOf(issue({ squad: [] }), 'cf.squad')).toEqual([null])
  })

  it('renders a number or a checkbox as its text', () => {
    expect(groupKeysOf(issue({ points: 8 }), 'cf.points')).toEqual(['8'])
    expect(groupKeysOf(issue({ approved: true }), 'cf.approved')).toEqual(['true'])
  })

  it('is not confused by a field key that looks like a built-in one', () => {
    // `cf.status` is a custom field called `status`, not the issue's status.
    expect(groupKeysOf(issue({ status: 'mine' }), 'cf.status')).toEqual(['mine'])
    expect(groupKeysOf(issue({ status: 'mine' }), 'status')).toEqual(['todo'])
  })
})

describe('groupIssues with a custom field', () => {
  it('buckets by value and puts the empty group last', () => {
    const groups = groupIssues(
      [issue({ severity: 's1' }, 'a'), issue({ severity: 's3' }, 'b'), issue({}, 'c')],
      'cf.severity',
      ctx,
    )
    expect(groups.map((g) => g.key)).toEqual(['s1', 's3', null])
    expect(groups.map((g) => g.items.length)).toEqual([1, 1, 1])
  })

  it('counts an issue once per value it holds', () => {
    const groups = groupIssues([issue({ squad: ['core', 'growth'] }, 'a')], 'cf.squad', ctx)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.items.length === 1)).toBe(true)
  })
})
