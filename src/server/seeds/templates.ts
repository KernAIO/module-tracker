import { createWorkflowFromTemplate } from '@kernhq/workflow'
import { type ProjectTemplateBody, ProjectTemplateId } from '../../contract/models.js'

/**
 * The project templates the tracker ships with.
 *
 * These are values, not database rows. A built-in used to be stored as a row with a null workspace,
 * which `listTemplates` could never return because it filters by workspace — so the built-ins were
 * unreachable by the very screen meant to offer them. In code they are also reviewable in a diff
 * and typed by the same `ProjectTemplateBody` a saved snapshot produces, so one applier serves both.
 *
 * Each one answers a question about a team, not about software: what do they track, what do they
 * need to record about it, and what does "done" mean for them.
 */

const workflow = (id: 'software' | 'kanban' | 'simple', name: string) => ({
  name,
  definition: createWorkflowFromTemplate(id, { id, name }),
})

/** Points, because software teams estimate in relative size rather than hours. */
const storyPoints = {
  key: 'story_points',
  name: 'Story points',
  type: 'number' as const,
  config: { min: 0, max: 100, precision: 0 },
  showInCards: true,
}

const severity = {
  key: 'severity',
  name: 'Severity',
  type: 'select' as const,
  description: 'How badly this hurts in production',
  options: [
    { id: 's1', label: 'S1 — everything is down', color: '#A63D26', order: 0, archived: false },
    { id: 's2', label: 'S2 — a lot of people, no way round it', color: '#B4661C', order: 1, archived: false },
    {
      id: 's3',
      label: 'S3 — annoying, there is a way round it',
      color: '#B49A5F',
      order: 2,
      archived: false,
    },
    { id: 's4', label: 'S4 — cosmetic', color: '#8E8779', order: 3, archived: false },
  ],
  showInCards: true,
}

export const SOFTWARE: ProjectTemplateBody = {
  version: 1,
  settings: { estimation: 'points', triage: { enabled: true } },
  workflows: [workflow('software', 'Software')],
  fields: [
    storyPoints,
    severity,
    {
      key: 'environment',
      name: 'Environment',
      type: 'select',
      options: [
        { id: 'production', label: 'Production', color: null, order: 0, archived: false },
        { id: 'staging', label: 'Staging', color: null, order: 1, archived: false },
        { id: 'local', label: 'Local', color: null, order: 2, archived: false },
      ],
    },
    {
      key: 'steps_to_reproduce',
      name: 'Steps to reproduce',
      type: 'textarea',
      description: 'What you did, what you expected, what happened instead',
    },
  ],
  types: [
    { key: 'epic', name: 'Epic', level: 1, icon: 'zap', workflowIndex: 0 },
    {
      key: 'story',
      name: 'Story',
      level: 0,
      icon: 'bookmark',
      isDefault: true,
      workflowIndex: 0,
      fieldLayout: [
        { fieldId: 'cf.story_points', section: 'sidebar', order: 8, required: false, hidden: false },
        // a story is not a defect, so the defect fields are not on it
        { fieldId: 'cf.severity', section: 'hidden', order: 30, required: false, hidden: true },
        { fieldId: 'cf.environment', section: 'hidden', order: 31, required: false, hidden: true },
        { fieldId: 'cf.steps_to_reproduce', section: 'hidden', order: 32, required: false, hidden: true },
      ],
    },
    { key: 'task', name: 'Task', level: 0, icon: 'square-check-big', workflowIndex: 0 },
    {
      key: 'bug',
      name: 'Bug',
      level: 0,
      icon: 'bug',
      workflowIndex: 0,
      fieldLayout: [
        { fieldId: 'cf.severity', section: 'sidebar', order: 1, required: true, hidden: false },
        { fieldId: 'cf.environment', section: 'sidebar', order: 2, required: false, hidden: false },
        { fieldId: 'cf.steps_to_reproduce', section: 'main', order: 2, required: false, hidden: false },
        { fieldId: 'cf.story_points', section: 'hidden', order: 30, required: false, hidden: true },
      ],
    },
    { key: 'sub_task', name: 'Sub-task', level: -1, icon: 'git-branch', workflowIndex: 0 },
  ],
  labels: [
    { name: 'regression', color: '#A63D26' },
    { name: 'good first issue', color: '#5ec269' },
    { name: 'needs design', color: '#a78bfa' },
  ],
  views: [
    {
      name: 'My work',
      kql: 'assignee = currentUser() and status != done',
      layout: 'list',
      visibility: 'project',
    },
    {
      name: 'Bugs by severity',
      kql: 'type = bug and status != done',
      layout: 'board',
      visibility: 'project',
    },
  ],
}

export const SUPPORT: ProjectTemplateBody = {
  version: 1,
  // Support teams answer to a clock, so triage and service levels are on from the start.
  settings: {
    estimation: 'hours',
    triage: { enabled: true },
    // A support team answers to a clock, so service levels are on from the start — with goals a
    // workspace fills in for itself, because nobody else can say what "soon" means to their
    // customers.
    sla: { enabled: true, goals: {}, pauseInCategories: [] },
  },
  workflows: [workflow('kanban', 'Support')],
  fields: [
    {
      key: 'customer',
      name: 'Customer',
      type: 'text',
      config: { maxLength: 120 },
      searchable: true,
      showInCards: true,
    },
    {
      key: 'channel',
      name: 'Came in by',
      type: 'select',
      options: [
        { id: 'email', label: 'Email', color: null, order: 0, archived: false },
        { id: 'portal', label: 'Portal', color: null, order: 1, archived: false },
        { id: 'chat', label: 'Chat', color: null, order: 2, archived: false },
        { id: 'phone', label: 'Phone', color: null, order: 3, archived: false },
      ],
    },
    {
      key: 'impact',
      name: 'Impact',
      type: 'select',
      required: true,
      options: [
        { id: 'blocked', label: 'Cannot work at all', color: '#A63D26', order: 0, archived: false },
        { id: 'degraded', label: 'Working, but badly', color: '#B4661C', order: 1, archived: false },
        { id: 'question', label: 'A question', color: '#8E8779', order: 2, archived: false },
      ],
      showInCards: true,
    },
    {
      key: 'csat',
      name: 'Satisfaction',
      type: 'number',
      description: 'What the customer said afterwards, 1 to 5',
      config: { min: 1, max: 5, precision: 0 },
    },
  ],
  types: [
    {
      key: 'ticket',
      name: 'Ticket',
      level: 0,
      icon: 'inbox',
      isDefault: true,
      workflowIndex: 0,
      fieldLayout: [
        { fieldId: 'cf.customer', section: 'sidebar', order: 1, required: false, hidden: false },
        { fieldId: 'cf.impact', section: 'sidebar', order: 2, required: true, hidden: false },
        { fieldId: 'cf.channel', section: 'sidebar', order: 3, required: false, hidden: false },
        { fieldId: 'cf.csat', section: 'sidebar', order: 20, required: false, hidden: false },
        // a ticket is a conversation with one customer, not a unit of estimated work
        { fieldId: 'estimate', section: 'hidden', order: 30, required: false, hidden: true },
        { fieldId: 'cycle', section: 'hidden', order: 31, required: false, hidden: true },
      ],
    },
    {
      key: 'problem',
      name: 'Problem',
      level: 1,
      icon: 'circle-alert',
      workflowIndex: 0,
      // the underlying cause behind several tickets: no single customer, no satisfaction score
      fieldLayout: [
        { fieldId: 'cf.customer', section: 'hidden', order: 30, required: false, hidden: true },
        { fieldId: 'cf.csat', section: 'hidden', order: 31, required: false, hidden: true },
        { fieldId: 'cf.impact', section: 'sidebar', order: 2, required: false, hidden: false },
      ],
    },
    { key: 'task', name: 'Task', level: 0, icon: 'square-check-big', workflowIndex: 0 },
  ],
  labels: [
    { name: 'billing', color: '#5ec269' },
    { name: 'bug report', color: '#A63D26' },
    { name: 'how do I', color: '#6e7f9a' },
  ],
  views: [
    {
      name: 'Waiting on us',
      kql: 'status != done and assignee = currentUser()',
      layout: 'list',
      visibility: 'project',
    },
    { name: 'By impact', kql: 'status != done', layout: 'board', visibility: 'project' },
  ],
}

export const MARKETING: ProjectTemplateBody = {
  version: 1,
  settings: { estimation: 'none' },
  workflows: [workflow('kanban', 'Marketing')],
  fields: [
    {
      key: 'channel',
      name: 'Channel',
      type: 'multiselect',
      options: [
        { id: 'blog', label: 'Blog', color: null, order: 0, archived: false },
        { id: 'email', label: 'Email', color: null, order: 1, archived: false },
        { id: 'social', label: 'Social', color: null, order: 2, archived: false },
        { id: 'event', label: 'Event', color: null, order: 3, archived: false },
        { id: 'paid', label: 'Paid', color: null, order: 4, archived: false },
      ],
      showInCards: true,
    },
    { key: 'audience', name: 'Audience', type: 'text', config: { maxLength: 120 } },
    { key: 'publish_date', name: 'Publish on', type: 'date', showInCards: true },
    {
      key: 'brand_approved',
      name: 'Brand approved',
      type: 'checkbox',
      description: 'Signed off by whoever owns the brand',
    },
    { key: 'asset_link', name: 'Asset', type: 'url', description: 'Where the artwork or copy lives' },
  ],
  types: [
    {
      key: 'campaign',
      name: 'Campaign',
      level: 1,
      icon: 'zap',
      workflowIndex: 0,
      fieldLayout: [
        { fieldId: 'cf.channel', section: 'sidebar', order: 1, required: false, hidden: false },
        { fieldId: 'cf.audience', section: 'sidebar', order: 2, required: false, hidden: false },
        { fieldId: 'cf.publish_date', section: 'sidebar', order: 3, required: false, hidden: false },
        { fieldId: 'cf.asset_link', section: 'hidden', order: 30, required: false, hidden: true },
      ],
    },
    {
      key: 'asset',
      name: 'Asset',
      level: 0,
      icon: 'bookmark',
      isDefault: true,
      workflowIndex: 0,
      fieldLayout: [
        { fieldId: 'cf.asset_link', section: 'sidebar', order: 1, required: false, hidden: false },
        { fieldId: 'cf.brand_approved', section: 'sidebar', order: 2, required: false, hidden: false },
        { fieldId: 'cf.publish_date', section: 'sidebar', order: 3, required: false, hidden: false },
        { fieldId: 'cf.channel', section: 'sidebar', order: 4, required: false, hidden: false },
      ],
    },
    {
      key: 'request',
      name: 'Request',
      level: 0,
      icon: 'inbox',
      workflowIndex: 0,
      fieldLayout: [
        { fieldId: 'cf.audience', section: 'sidebar', order: 1, required: false, hidden: false },
        { fieldId: 'cf.brand_approved', section: 'hidden', order: 30, required: false, hidden: true },
      ],
    },
  ],
  labels: [
    { name: 'launch', color: '#A63D26' },
    { name: 'evergreen', color: '#5ec269' },
    { name: 'needs copy', color: '#a78bfa' },
  ],
  views: [
    { name: 'Publishing soon', kql: 'status != done', layout: 'list', visibility: 'project' },
    { name: 'By stage', kql: 'status != done', layout: 'board', visibility: 'project' },
  ],
}

/** Deliberately bare: a list of things to do, and nothing to learn before you can use it. */
export const SIMPLE: ProjectTemplateBody = {
  version: 1,
  settings: { estimation: 'none' },
  workflows: [workflow('simple', 'Simple')],
  fields: [],
  types: [
    { key: 'task', name: 'Task', level: 0, icon: 'square-check-big', isDefault: true, workflowIndex: 0 },
  ],
  labels: [],
  views: [{ name: 'Everything', kql: '', layout: 'list', visibility: 'project' }],
}

/**
 * `kanban` and `blank` are kept because projects were created from them before the four shapes
 * existed. They map onto the nearest of the four rather than being maintained separately.
 */
export const PROJECT_TEMPLATES: Record<ProjectTemplateId, ProjectTemplateBody> = {
  software: SOFTWARE,
  support: SUPPORT,
  marketing: MARKETING,
  simple: SIMPLE,
  kanban: { ...SIMPLE, workflows: [workflow('kanban', 'Kanban')] },
  blank: SIMPLE,
}

export const projectTemplateBody = (id: string): ProjectTemplateBody =>
  PROJECT_TEMPLATES[ProjectTemplateId.catch('simple').parse(id)]

/** What a chooser shows: the four shapes, in the order a team is likely to want them. */
export const PROJECT_TEMPLATE_CHOICES = [
  { id: 'software', name: 'Software', description: 'Epics, stories, bugs, and a review step.' },
  { id: 'support', name: 'Support desk', description: 'Tickets with a customer, an impact and a clock.' },
  { id: 'marketing', name: 'Marketing', description: 'Campaigns, assets and requests, with a publish date.' },
  { id: 'simple', name: 'Simple task list', description: 'Tasks. Nothing to learn first.' },
] as const
