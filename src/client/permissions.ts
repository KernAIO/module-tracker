import { session } from '@kernhq/ui'

/**
 * The tracker permissions the issues views gate on.
 *
 * These are the keys the module's contract declares (`trackerPermissions`). The server checks them
 * again on every call — this is only so the interface does not offer something that would be
 * refused. Anything a person may never do is hidden; anything they cannot do *right now* stays
 * visible and disabled with a reason.
 */
export const TRACKER_PERMISSIONS = {
  view: 'tracker.issue.view',
  create: 'tracker.issue.create',
  edit: 'tracker.issue.edit_any',
  transition: 'tracker.issue.transition',
  assign: 'tracker.issue.assign',
  comment: 'tracker.issue.comment',
  bulkEdit: 'tracker.issue.bulk_edit',
  archive: 'tracker.issue.archive',
  /** the settings screens: fields have their own key, types share the workflow one */
  fieldManage: 'tracker.field.manage',
  typeManage: 'tracker.workflow.manage',
  workflowManage: 'tracker.workflow.manage',
  projectManage: 'tracker.project.manage',
  viewManageShared: 'tracker.view.manage_shared',
  triageManage: 'tracker.triage.manage',
} as const

export type TrackerPermission = keyof typeof TRACKER_PERMISSIONS

export function canTracker(permission: TrackerPermission): boolean {
  return session.can(TRACKER_PERMISSIONS[permission])
}
