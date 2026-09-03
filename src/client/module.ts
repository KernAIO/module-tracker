import { defineClientModule } from '@kernhq/ui'
import { t, trackerMessageBundles } from './i18n.js'
import { TRACKER_PERMISSIONS } from './permissions.js'

/**
 * The tracker as the shell sees it.
 *
 * A module does not reach into the application: it declares what it contributes — navigation, pages,
 * command-palette actions, keyboard shortcuts and how its objects are drawn elsewhere — and the shell
 * composes that with whatever else is enabled for the workspace. Turning the tracker off in workspace
 * settings removes all of it without a single conditional anywhere in the shell.
 *
 * Labels are getters rather than strings because a module is defined once at import time while the
 * interface language can change afterwards; reading them on render keeps the rail and the palette in
 * the language the person actually chose.
 */
export const trackerClientModule = defineClientModule({
  id: 'tracker',
  name: 'Issues',
  icon: 'square-check-big',
  messages: trackerMessageBundles,

  nav: [
    {
      id: 'tracker',
      get label() {
        return t('nav')
      },
      icon: 'square-check-big',
      href: '/tracker',
      order: 20,
      permission: TRACKER_PERMISSIONS.view,
    },
  ],

  routes: [
    {
      path: '/tracker/reports',
      component: () => import('./pages/ReportsPage.svelte'),
      get title() {
        return t('reports_title')
      },
      permission: TRACKER_PERMISSIONS.view,
    },
    {
      // One project, one page per concern: /tracker/projects/KRN (sections default to components),
      // .../KRN/components, .../KRN/milestones, .../KRN/cycles and .../KRN/templates. ProjectPage
      // picks the screen from the section; the sidebar's project rows move between them. The key is
      // the project's `key` (`KRN`), which is what the URL carries and what the pages look up.
      path: '/tracker/projects/:key',
      component: () => import('./pages/ProjectPage.svelte'),
      get title() {
        return t('title')
      },
      permission: TRACKER_PERMISSIONS.view,
    },
    {
      path: '/tracker/projects/:key/:section',
      component: () => import('./pages/ProjectPage.svelte'),
      get title() {
        return t('title')
      },
      permission: TRACKER_PERMISSIONS.view,
    },
    {
      path: '/tracker',
      component: () => import('./pages/IssuesPage.svelte'),
      get title() {
        return t('title')
      },
      permission: TRACKER_PERMISSIONS.view,
    },
  ],

  widgets: [
    {
      id: 'tracker.issues',
      get title() {
        return t('widget_issues_title')
      },
      get description() {
        return t('widget_issues_desc')
      },
      icon: 'square-check-big',
      permission: TRACKER_PERMISSIONS.view,
      sizes: ['m', 'l', 'xl'],
      defaultSize: 'l',
      order: 10,
      // One widget instead of six. Every one of these settings resolves into the KQL that
      // `issues.query` already answers, which is why the same card can be placed twice showing two
      // entirely different lists.
      settings: [
        {
          kind: 'select',
          key: 'preset',
          get label() {
            return t('common.setting_show')
          },
          default: 'assigned',
          get options() {
            return [
              { value: 'assigned', label: t('preset_assigned') },
              { value: 'active', label: t('preset_active') },
              { value: 'backlog', label: t('preset_backlog') },
              { value: 'created', label: t('preset_created') },
              { value: 'subscribed', label: t('preset_subscribed') },
              { value: 'triage', label: t('widget_preset_triage') },
            ]
          },
        },
        {
          kind: 'select',
          key: 'view',
          get label() {
            return t('widget_setting_saved_view')
          },
          default: null,
          nullable: true,
          get nullLabel() {
            return t('widget_setting_no_view')
          },
          loadOptions: async (ctx) => {
            const { getTrackerApi } = await import('./api-instance.js')
            const views = await getTrackerApi().views.list({ workspaceId: ctx.workspaceId })
            return views.map((v) => ({ value: v.id, label: v.name }))
          },
        },
        {
          kind: 'number',
          key: 'limit',
          get label() {
            return t('common.setting_rows')
          },
          default: 8,
          min: 3,
          max: 20,
        },
      ],
      component: () => import('./widgets/IssuesWidget.svelte'),
    },
    {
      id: 'tracker.stat-assigned',
      get title() {
        return t('widget_assigned_title')
      },
      get description() {
        return t('widget_assigned_desc')
      },
      icon: 'square-check-big',
      permission: TRACKER_PERMISSIONS.view,
      sizes: ['s'],
      defaultSize: 's',
      compact: true,
      order: 20,
      component: () => import('./widgets/AssignedCountWidget.svelte'),
    },
    {
      id: 'tracker.stat-due-soon',
      get title() {
        return t('widget_due_soon_title')
      },
      get description() {
        return t('widget_due_soon_desc')
      },
      icon: 'clock',
      permission: TRACKER_PERMISSIONS.view,
      sizes: ['s'],
      defaultSize: 's',
      compact: true,
      order: 30,
      component: () => import('./widgets/DueSoonCountWidget.svelte'),
    },
    {
      id: 'tracker.cycle-progress',
      get title() {
        return t('widget_cycle_title')
      },
      get description() {
        return t('widget_cycle_desc')
      },
      icon: 'gauge',
      permission: TRACKER_PERMISSIONS.view,
      sizes: ['m', 'l'],
      defaultSize: 'm',
      order: 40,
      settings: [
        {
          kind: 'select',
          key: 'project',
          get label() {
            return t('widget_setting_project')
          },
          default: null,
          nullable: true,
          get nullLabel() {
            return t('common.any')
          },
          loadOptions: async (ctx) => {
            const { getTrackerApi } = await import('./api-instance.js')
            const projects = await getTrackerApi().projects.list({ workspaceId: ctx.workspaceId })
            return projects.map((p) => ({ value: p.id, label: p.name }))
          },
        },
      ],
      component: () => import('./widgets/CycleWidget.svelte'),
    },
    {
      id: 'tracker.velocity',
      get title() {
        return t('widget_velocity_title')
      },
      get description() {
        return t('widget_velocity_desc')
      },
      icon: 'chart-column',
      permission: TRACKER_PERMISSIONS.view,
      // A grouped bar chart is unreadable in a quarter-width card, so `s` is not offered.
      sizes: ['l', 'xl'],
      defaultSize: 'l',
      order: 60,
      settings: [
        {
          kind: 'select',
          key: 'project',
          get label() {
            return t('widget_setting_project')
          },
          default: null,
          nullable: true,
          get nullLabel() {
            return t('common.any')
          },
          loadOptions: async (ctx) => {
            const { getTrackerApi } = await import('./api-instance.js')
            const projects = await getTrackerApi().projects.list({ workspaceId: ctx.workspaceId })
            return projects.map((p) => ({ value: p.id, label: p.name }))
          },
        },
        {
          kind: 'number',
          key: 'lastN',
          get label() {
            return t('widget_velocity_cycles')
          },
          default: 6,
          min: 3,
          max: 12,
        },
      ],
      component: () => import('./widgets/VelocityWidget.svelte'),
    },
    {
      id: 'tracker.created-vs-resolved',
      get title() {
        return t('widget_throughput_title')
      },
      get description() {
        return t('widget_throughput_desc')
      },
      icon: 'chart-line',
      permission: TRACKER_PERMISSIONS.view,
      sizes: ['l', 'xl'],
      defaultSize: 'xl',
      order: 70,
      settings: [
        {
          kind: 'select',
          key: 'project',
          get label() {
            return t('widget_setting_project')
          },
          default: null,
          nullable: true,
          get nullLabel() {
            return t('common.any')
          },
          loadOptions: async (ctx) => {
            const { getTrackerApi } = await import('./api-instance.js')
            const projects = await getTrackerApi().projects.list({ workspaceId: ctx.workspaceId })
            return projects.map((p) => ({ value: p.id, label: p.name }))
          },
        },
        {
          kind: 'select',
          key: 'range',
          get label() {
            return t('widget_setting_range')
          },
          default: '30',
          get options() {
            return [
              { value: '14', label: t('widget_range_14') },
              { value: '30', label: t('widget_range_30') },
              { value: '90', label: t('widget_range_90') },
            ]
          },
        },
      ],
      component: () => import('./widgets/ThroughputWidget.svelte'),
    },
    {
      id: 'tracker.timer',
      get title() {
        return t('widget_timer_title')
      },
      get description() {
        return t('widget_timer_desc')
      },
      icon: 'timer',
      permission: TRACKER_PERMISSIONS.view,
      sizes: ['s', 'm'],
      defaultSize: 's',
      compact: true,
      order: 50,
      component: () => import('./widgets/TimerWidget.svelte'),
    },
  ],

  commands: [
    {
      id: 'tracker.new-issue',
      get label() {
        return t('new_issue')
      },
      icon: 'plus',
      shortcut: ['c'],
      permission: TRACKER_PERMISSIONS.create,
      run: (ctx) => ctx.navigate('/tracker?new=1'),
    },
    {
      id: 'tracker.issues',
      get label() {
        return t('cmd_open_list')
      },
      icon: 'list',
      permission: TRACKER_PERMISSIONS.view,
      run: (ctx) => ctx.navigate('/tracker'),
    },
    {
      id: 'tracker.board',
      get label() {
        return t('cmd_open_board')
      },
      icon: 'columns-3',
      permission: TRACKER_PERMISSIONS.view,
      run: (ctx) => ctx.navigate('/tracker?view=board'),
    },
    {
      id: 'tracker.my-issues',
      get label() {
        return t('cmd_my_issues')
      },
      icon: 'user',
      permission: TRACKER_PERMISSIONS.view,
      run: (ctx) => ctx.navigate('/tracker?preset=assigned'),
    },
    {
      id: 'tracker.triage',
      get label() {
        return t('cmd_triage')
      },
      icon: 'inbox',
      permission: TRACKER_PERMISSIONS.view,
      run: (ctx) => ctx.navigate('/tracker?q=triage%20%3D%20true'),
    },
    {
      id: 'tracker.reports',
      get label() {
        return t('reports_title')
      },
      icon: 'activity',
      permission: TRACKER_PERMISSIONS.view,
      run: (ctx) => ctx.navigate('/tracker/reports'),
    },
    {
      id: 'tracker.by-project',
      get label() {
        return t('cmd_by_project')
      },
      icon: 'diamond',
      permission: TRACKER_PERMISSIONS.view,
      run: (ctx) => ctx.navigate('/tracker?group=project'),
    },
  ],

  shortcuts: [
    {
      id: 'tracker.new-issue',
      keys: ['c'],
      get label() {
        return t('new_issue')
      },
      scope: 'tracker',
      run: (ctx) => ctx.navigate('/tracker?new=1'),
    },
  ],

  sidebar: [
    {
      id: 'tracker',
      match: ['tracker'],
      permission: TRACKER_PERMISSIONS.view,
      controls: () => import('./components/TrackerControls.svelte'),
      component: () => import('./components/TrackerSidebar.svelte'),
    },
    {
      // The three "my work" rows used to live in the application layout, where a workspace with the
      // tracker switched off still saw them.
      id: 'tracker.home',
      match: [''],
      order: 20,
      permission: TRACKER_PERMISSIONS.view,
      component: () => import('./components/HomeLinks.svelte'),
    },
  ],

  /**
   * Where the tracker is configured. The shell builds the settings nav from these — label, icon and
   * permission — while the route itself is conventional (`/settings/<module>/<id>`), so a module
   * does not have to mount pages dynamically to be configurable.
   */
  settingsPages: [
    {
      id: 'fields',
      get label() {
        return t('settings_fields')
      },
      icon: 'tag',
      scope: 'workspace',
      permission: TRACKER_PERMISSIONS.fieldManage,
      order: 10,
      component: () => import('./settings/FieldsSettings.svelte'),
    },
    {
      id: 'workflows',
      get label() {
        return t('settings_workflows')
      },
      icon: 'git-branch',
      scope: 'workspace',
      permission: TRACKER_PERMISSIONS.workflowManage,
      order: 25,
      component: () => import('./settings/WorkflowsSettings.svelte'),
    },
    {
      id: 'projects',
      get label() {
        return t('settings_projects')
      },
      icon: 'folder',
      scope: 'workspace',
      permission: TRACKER_PERMISSIONS.projectManage,
      order: 5,
      component: () => import('./settings/ProjectsSettings.svelte'),
    },
    {
      id: 'repeating',
      get label() {
        return t('settings_repeating')
      },
      icon: 'refresh-cw',
      scope: 'workspace',
      permission: TRACKER_PERMISSIONS.projectManage,
      order: 40,
      component: () => import('./settings/RepeatingSettings.svelte'),
    },
    {
      id: 'import',
      get label() {
        return t('settings_import')
      },
      icon: 'upload',
      scope: 'workspace',
      permission: TRACKER_PERMISSIONS.projectManage,
      order: 50,
      component: () => import('./settings/ImportSettings.svelte'),
    },
    {
      id: 'planning',
      get label() {
        return t('settings_planning')
      },
      icon: 'diamond',
      scope: 'workspace',
      permission: TRACKER_PERMISSIONS.projectManage,
      order: 30,
      component: () => import('./settings/PlanningSettings.svelte'),
    },
    {
      id: 'types',
      get label() {
        return t('settings_types')
      },
      icon: 'layout-grid',
      scope: 'workspace',
      permission: TRACKER_PERMISSIONS.typeManage,
      order: 20,
      component: () => import('./settings/TypesSettings.svelte'),
    },
  ],

  presenters: [
    {
      type: 'issue',
      inline: () => import('./components/IssueInline.svelte'),
      page: (id, workspaceSlug) => `/${workspaceSlug}/tracker?issue=${encodeURIComponent(id)}`,
    },
  ],
})

export default trackerClientModule
