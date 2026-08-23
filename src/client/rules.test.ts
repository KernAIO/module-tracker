import { describe, expect, it } from 'vitest'
import { describeApprovers, describeRule } from './rules.js'

const say = (type: string, config?: unknown) => describeRule({ type, config }).text

describe('describeRule', () => {
  it('says who may do it', () => {
    expect(say('user.isAssignee')).toBe('Only the assignee')
    expect(say('user.hasPermission', { permission: 'tracker.issue.transition' })).toBe(
      'Only somebody with “tracker.issue.transition”',
    )
  })

  it('says what has to be true first', () => {
    expect(say('subtasks.allDone')).toBe('Only when every sub-issue is done')
    expect(say('field.equals', { field: 'priority', value: 'urgent' })).toBe('Only when priority is “urgent”')
  })

  it('says what has to be filled in', () => {
    expect(say('comment.required')).toBe('A comment is required')
    expect(say('field.required', { field: 'resolution' })).toBe('resolution must be filled in')
  })

  it('says what happens afterwards, in the terms the config uses', () => {
    expect(say('assign.to', { to: 'currentUser' })).toBe('Assigns it to whoever moved it')
    expect(say('assign.to', { to: 'unassigned' })).toBe('Assigns it to nobody')
    expect(say('resolution.set', { value: 'done' })).toBe('Sets the resolution to “done”')
    expect(say('resolution.set', { value: null })).toBe('Clears the resolution')
    expect(say('notify', { subjects: [{ kind: 'assignee' }, { kind: 'reporter' }] })).toBe(
      'Notifies the assignee, the reporter',
    )
  })

  it('copes with a rule that arrives without its configuration', () => {
    // A definition written by hand, or one from an older server.
    expect(say('field.required')).toBe('A field must be filled in')
    expect(say('webhook')).toBe('Calls a webhook')
  })

  it('names a rule it does not know rather than guessing', () => {
    // A rule from a newer server, or one an extension added.
    const described = describeRule({ type: 'acme.custom_check' })
    expect(described.text).toBe('acme.custom_check')
    expect(described.unknown).toBe(true)
  })
})

describe('describeApprovers', () => {
  it('says how many and from whom', () => {
    expect(describeApprovers([{ kind: 'role', id: 'admin' }], 1)).toBe(
      'Approval from anyone with the admin role',
    )
    expect(describeApprovers([{ kind: 'projectLead' }], 2)).toBe('2 approvals from the project lead')
  })

  it('says nobody when the list is empty, which is a workflow that can never proceed', () => {
    expect(describeApprovers([], 1)).toBe('Approval from nobody')
  })
})
