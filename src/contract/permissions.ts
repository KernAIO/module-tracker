import { definePermissions } from '@kernalo/contracts'

/**
 * Tracker permission keys. Bindings may be set at workspace scope (roles) or at project scope
 * (per-project permission schemes via the kernel authz bindings API).
 */
export const trackerPermissions = definePermissions([
  // projects
  {
    key: 'tracker.project.view',
    label: 'View projects',
    description: 'See projects and their configuration',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'tracker.project.create',
    label: 'Create projects',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.project.manage',
    label: 'Manage projects',
    description: 'Edit project settings, members, components, labels and intake',
    scope: 'project',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'tracker.project.delete',
    label: 'Delete projects',
    scope: 'project',
    defaultRoles: ['owner', 'admin'],
    dangerous: true,
  },

  // issues
  {
    key: 'tracker.issue.view',
    label: 'View issues',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.create',
    label: 'Create issues',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.edit',
    label: 'Edit own issues',
    description: 'Edit issues the user reported or is assigned to',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.edit_any',
    label: 'Edit any issue',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.delete_any',
    label: 'Delete issues',
    scope: 'project',
    defaultRoles: ['owner', 'admin'],
    dangerous: true,
  },
  {
    key: 'tracker.issue.transition',
    label: 'Transition issues',
    description: 'Move issues through the workflow',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.assign',
    label: 'Assign issues',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.comment',
    label: 'Comment on issues',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member', 'guest'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.bulk_edit',
    label: 'Bulk edit issues',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.issue.archive',
    label: 'Archive issues',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },

  // planning & configuration
  {
    key: 'tracker.cycle.manage',
    label: 'Manage cycles',
    description: 'Create, start and complete cycles and milestones',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.version.manage',
    label: 'Manage versions',
    description: 'Create and release versions',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.workflow.manage',
    label: 'Manage workflows',
    description: 'Edit workflows, workflow schemes and work item types',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'tracker.field.manage',
    label: 'Manage custom fields',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: 'tracker.view.manage_shared',
    label: 'Manage shared views',
    description: 'Create and edit project/workspace visible views',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },

  // time tracking
  {
    key: 'tracker.worklog.log',
    label: 'Log work',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.worklog.edit_any',
    label: 'Edit any worklog',
    scope: 'project',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },

  // triage & import
  {
    key: 'tracker.triage.manage',
    label: 'Manage triage',
    description: 'Accept, decline and snooze triage items; configure intake',
    scope: 'project',
    defaultRoles: ['owner', 'admin', 'member'],
    dangerous: false,
  },
  {
    key: 'tracker.import.run',
    label: 'Run imports',
    description: 'Import issues from CSV, Jira or Linear',
    scope: 'project',
    defaultRoles: ['owner', 'admin'],
    dangerous: true,
  },
])
