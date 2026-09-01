/**
 * The tracker permission matrix, blessed rather than assumed.
 *
 * Defaults are declared one permission at a time in `permissions.ts`, which makes the whole
 * picture — which built-in role ends up holding what — impossible to read from any single line.
 * This test writes that picture out in full and compares it against what the module declares, so
 * "a guest can comment on an issue" is something a reviewer can read instead of derive.
 *
 * The expected rows are the *effective* grants, cascade included. The kernel expands declared
 * `defaultRoles` upward through the role order guest ⊆ member ⊆ admin ⊆ owner (see
 * `Authz.registerPermissions`): a permission declaring `['member']` is held by member, admin and
 * owner. `permissionMatrixDiff` applies the same expansion, so `BLESSED` lists every role that
 * holds the permission, not the roles the declaration happens to name.
 *
 * Changing a default is meant to be deliberate, and the workflow is: edit `defaultRoles` in
 * `permissions.ts` → this test fails and names every row that moved → confirm the change is what
 * you meant → update `BLESSED` in the same commit. Two statements of the same decision, one where
 * it is declared and one where it is agreed.
 *
 * What is not tested here is the cascade itself, or that any procedure asks for these keys. The
 * kernel tests its own expansion; this file pins tracker's declared defaults and nothing else.
 */
import { permissionMatrixDiff } from '@kernhq/testing'
import { describe, expect, it } from 'vitest'
import { trackerPermissions } from './permissions.js'

/**
 * The reviewed matrix. Each row lists every built-in role that holds the permission by default,
 * lowest role first — so the first entry is the floor: a row starting at `member` denies guests, and
 * one starting at `guest` gives it to everybody in the workspace.
 */
const BLESSED: Record<string, readonly string[]> = {
  // projects
  'tracker.project.view': ['guest', 'member', 'admin', 'owner'],
  'tracker.project.create': ['member', 'admin', 'owner'],
  'tracker.project.manage': ['admin', 'owner'],
  'tracker.project.delete': ['admin', 'owner'],

  // issues
  'tracker.issue.view': ['guest', 'member', 'admin', 'owner'],
  'tracker.issue.create': ['guest', 'member', 'admin', 'owner'],
  'tracker.issue.edit': ['guest', 'member', 'admin', 'owner'],
  'tracker.issue.edit_any': ['member', 'admin', 'owner'],
  'tracker.issue.delete_any': ['admin', 'owner'],
  'tracker.issue.transition': ['member', 'admin', 'owner'],
  'tracker.issue.assign': ['member', 'admin', 'owner'],
  'tracker.issue.manage_watchers': ['member', 'admin', 'owner'],
  'tracker.issue.comment': ['guest', 'member', 'admin', 'owner'],
  'tracker.issue.bulk_edit': ['member', 'admin', 'owner'],
  'tracker.issue.archive': ['member', 'admin', 'owner'],

  // planning & configuration
  'tracker.cycle.manage': ['member', 'admin', 'owner'],
  'tracker.version.manage': ['member', 'admin', 'owner'],
  'tracker.workflow.manage': ['admin', 'owner'],
  'tracker.field.manage': ['admin', 'owner'],
  'tracker.view.manage_shared': ['member', 'admin', 'owner'],

  // time tracking
  'tracker.worklog.log': ['member', 'admin', 'owner'],
  'tracker.worklog.edit_any': ['admin', 'owner'],

  // triage & import
  'tracker.triage.manage': ['member', 'admin', 'owner'],
  'tracker.import.run': ['admin', 'owner'],
}

/** Permissions whose misuse costs data or reaches outside the workspace. */
const DANGEROUS = ['tracker.project.delete', 'tracker.issue.delete_any', 'tracker.import.run']

describe('tracker permissions', () => {
  it('grants each permission to exactly the blessed roles', () => {
    // One assertion on purpose: the diff collects every mismatch, so a change that moves several
    // rows is reported once and in full rather than one failure per run.
    expect(permissionMatrixDiff(trackerPermissions, BLESSED)).toEqual([])
  })

  it('namespaces every key under the module id and declares it once', () => {
    const keys = trackerPermissions.map((p) => p.key)
    expect(keys.filter((key) => !key.startsWith('tracker.'))).toEqual([])
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([])
  })

  it('marks exactly the destructive permissions dangerous', () => {
    const flagged = trackerPermissions.filter((p) => p.dangerous).map((p) => p.key)
    expect(flagged.toSorted()).toEqual(DANGEROUS.toSorted())
  })
})
