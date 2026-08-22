import type { core } from '@kernhq/contracts'

/** Notification types emitted by the tracker (drives the user preference UI). */
export const trackerNotificationTypes: core.NotificationTypeDef[] = [
  {
    type: 'tracker.issue.assigned',
    label: 'Issue assigned to you',
    defaults: { inapp: true, push: true, email: true },
    urgent: true,
  },
  {
    type: 'tracker.issue.mentioned',
    label: 'Mentioned in an issue or comment',
    defaults: { inapp: true, push: true, email: true },
    urgent: true,
  },
  {
    type: 'tracker.issue.commented',
    label: 'New comment on a watched issue',
    defaults: { inapp: true, push: true, email: false },
    urgent: false,
  },
  {
    type: 'tracker.issue.status_changed',
    label: 'Status change on a watched issue',
    defaults: { inapp: true, push: false, email: false },
    urgent: false,
  },
  {
    type: 'tracker.issue.due_soon',
    label: 'Issue due soon',
    defaults: { inapp: true, push: true, email: true },
    urgent: false,
  },
  {
    type: 'tracker.issue.approval_requested',
    label: 'Your approval is requested',
    defaults: { inapp: true, push: true, email: true },
    urgent: true,
  },
  {
    type: 'tracker.cycle.ending',
    label: 'Cycle ending soon',
    defaults: { inapp: true, push: false, email: false },
    urgent: false,
  },
]
