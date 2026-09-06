/**
 * Demo content for the tracker.
 *
 * Written through the module's own services rather than as table inserts, so everything a real
 * project has is there: issue counters and keys, ranks, the built-in views, the workflow the
 * template chose, status history for anything that has moved. A row put in by hand would look right
 * on the board and be missing whatever the next screen reads.
 *
 * Dates are relative to `now` (see `DemoSeedContext`), so the demo reads as this week whenever it is
 * created — a sprint that ends next Friday, an issue raised yesterday.
 */
import type { DemoSeedContext, DemoSeedSummary, Tx } from '@kernhq/kernel'
import type { StatusCategory } from '@kernhq/workflow'
import { eq } from 'drizzle-orm'
import type { Priority, Project } from '../contract/models.js'
import { textToDoc } from './rich.js'
import { projects } from './schema.js'
import { type TrackerServices, trackerServices, withWs } from './services/index.js'

const DAY = 86_400_000

const at = (now: Date, days: number): Date => new Date(now.getTime() + days * DAY)
const dateOnly = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * One issue as the seed describes it.
 *
 * `status` is a *category*, not a status id: the id belongs to whichever workflow the project
 * template installed, and hard-coding one would tie this file to a template it does not own. The
 * seeder resolves a category to a real status against the project's own workflow definition.
 */
interface Seed {
  title: string
  body: string
  /**
   * A `StatusCategory` from `@kernhq/workflow`, and it has to be exactly one of those.
   *
   * The set is `backlog | todo | in_progress | done | cancelled | triage`. An invented name
   * (`started`, `completed`) matches no status in any workflow, so the move is simply not made —
   * and because a failed move is caught and ignored below, the issue stays in the workflow's
   * initial status with nothing reported. That is what the first run of this seeder did: twenty-five
   * issues, every one of them in `backlog`, and a green log line.
   */
  status: StatusCategory
  priority: Priority
  labels?: string[]
  component?: string
  estimate?: number
  /** days from `now`; negative is in the past */
  due?: number
  inCycle?: boolean
  comments?: string[]
  /**
   * Values for the project template's own fields, by field key.
   *
   * Nothing sets it today — see the note on the support project's template below for why the one
   * template with a required field is not used here — but a seeder that uses a template inherits
   * that template's rules like any other caller, so the hook stays.
   */
  custom?: Record<string, unknown>
}

const WEB: Seed[] = [
  {
    title: 'Rebuild the pricing page',
    body: 'Three plans, a comparison table and an annual toggle. The current page has not changed since launch and does not mention the team plan at all.',
    status: 'in_progress',
    priority: 'high',
    labels: ['website'],
    component: 'Marketing site',
    estimate: 5,
    due: 6,
    inCycle: true,
    comments: [
      'First draft of the copy is in the shared doc — the comparison table is the part still open.',
      'Design is happy with the three-column layout. Annual toggle stays out of the first pass.',
    ],
  },
  {
    title: 'Customer stories section on the home page',
    body: 'Three logos and a quote each, above the fold on desktop and below the hero on mobile.',
    status: 'in_progress',
    priority: 'medium',
    labels: ['website', 'content'],
    component: 'Marketing site',
    estimate: 3,
    due: 9,
    inCycle: true,
  },
  {
    title: 'Docs search returns nothing for two-word queries',
    body: 'Searching "api key" returns no results while "api" and "key" each return several. Reported by two customers this week.',
    status: 'in_progress',
    priority: 'urgent',
    labels: ['bug', 'docs'],
    component: 'Documentation',
    estimate: 2,
    due: 2,
    inCycle: true,
    comments: ['Reproduced on staging. The query is being passed through unquoted.'],
  },
  {
    title: 'Add a changelog page',
    body: 'One entry per release, newest first, with an RSS feed. Content comes from the release notes we already write.',
    status: 'todo',
    priority: 'medium',
    labels: ['website'],
    component: 'Marketing site',
    estimate: 3,
    inCycle: true,
  },
  {
    title: 'Cookie banner blocks the sign-up button on small screens',
    body: 'On a 375px viewport the banner covers the primary action and cannot be dismissed without scrolling.',
    status: 'done',
    priority: 'high',
    labels: ['bug', 'website'],
    component: 'Marketing site',
    estimate: 1,
    inCycle: true,
  },
  {
    title: 'Translate the home page into German',
    body: 'Header, hero, feature grid and footer. Pricing stays in English for now.',
    status: 'backlog',
    priority: 'low',
    labels: ['content'],
    component: 'Marketing site',
    estimate: 5,
  },
  {
    title: 'Replace the stock photography',
    body: 'The team photographs on the about page are placeholders from the original theme.',
    status: 'backlog',
    priority: 'low',
    labels: ['website'],
    component: 'Marketing site',
  },
  {
    title: 'Move the blog off the old CMS',
    body: 'Forty-one posts, twelve authors. Redirects for every existing URL are the part that has to be right.',
    status: 'backlog',
    priority: 'medium',
    labels: ['content'],
    estimate: 8,
  },
]

const APP: Seed[] = [
  {
    title: 'Offline mode for the task list',
    body: 'Queue writes locally and reconcile on reconnect. The list is the one screen people open on a train.',
    status: 'in_progress',
    priority: 'high',
    labels: ['mobile'],
    component: 'Sync',
    estimate: 13,
    due: 11,
    inCycle: true,
    comments: [
      'Going with a write-ahead queue rather than a full local database — the reconcile is simpler and we do not need queries offline.',
    ],
  },
  {
    title: 'Push notifications are delivered twice on Android',
    body: 'Both the FCM handler and the background service claim the message. Only reproducible on Android 14.',
    status: 'in_progress',
    priority: 'urgent',
    labels: ['bug', 'mobile'],
    component: 'Notifications',
    estimate: 3,
    due: 1,
    inCycle: true,
    comments: ['Traced to the service registering a second listener after a cold start.'],
  },
  {
    title: 'Biometric unlock',
    body: 'Face ID and fingerprint, off by default, with a passcode fallback after three failures.',
    status: 'todo',
    priority: 'medium',
    labels: ['mobile', 'security'],
    component: 'Accounts',
    estimate: 5,
    inCycle: true,
  },
  {
    title: 'Cut the cold-start time below one second',
    body: 'Currently 2.4s on a mid-range Android device. Most of it is spent restoring the last session.',
    status: 'todo',
    priority: 'high',
    labels: ['performance'],
    estimate: 8,
    inCycle: true,
  },
  {
    title: 'Attachments over 10 MB fail without an error',
    body: 'The upload stops and the composer stays open with no message. The limit is real; the silence is the bug.',
    status: 'done',
    priority: 'high',
    labels: ['bug', 'mobile'],
    component: 'Sync',
    estimate: 2,
    inCycle: true,
  },
  {
    title: 'Dark mode follows the system setting',
    body: 'Three states: light, dark, follow system. Follow system is the new default.',
    status: 'done',
    priority: 'medium',
    labels: ['mobile'],
    estimate: 3,
    inCycle: true,
  },
  {
    title: 'Tablet layout for the split view',
    body: 'List on the left, detail on the right, with the same navigation as the phone at narrow widths.',
    status: 'backlog',
    priority: 'medium',
    labels: ['mobile'],
    estimate: 8,
  },
  {
    title: 'Widget for the home screen',
    body: 'Today’s items, refreshed hourly. iOS first.',
    status: 'backlog',
    priority: 'low',
    labels: ['mobile'],
    estimate: 5,
  },
  {
    title: 'Drop support for iOS 15',
    body: 'Under 2% of sessions and it is what keeps the compatibility shims in the codebase.',
    status: 'cancelled',
    priority: 'low',
    labels: ['mobile'],
  },
]

const SUP: Seed[] = [
  {
    title: 'Export fails for workspaces over 2 GB',
    body: 'Raised by a customer on the business plan. The job times out rather than failing, so nothing tells them.',
    status: 'in_progress',
    priority: 'urgent',
    labels: ['bug', 'escalation'],
    due: 1,
    comments: ['Customer has been told we are on it and given a manual export in the meantime.'],
  },
  {
    title: 'Invitation emails land in spam at one customer',
    body: 'Their mail provider rejects our DKIM signature. Affects one domain only.',
    status: 'in_progress',
    priority: 'high',
    labels: ['escalation'],
    due: 3,
  },
  {
    title: 'How do I move a project between workspaces?',
    body: 'Asked three times this month. There is no answer in the docs because there is no way to do it.',
    status: 'todo',
    priority: 'medium',
    labels: ['question', 'docs'],
  },
  {
    title: 'Billing page shows the wrong currency for EU customers',
    body: 'Prices are correct at checkout, so this is display only — but it is the page people screenshot.',
    status: 'todo',
    priority: 'high',
    labels: ['bug'],
    due: 5,
  },
  {
    title: 'Request: bulk-assign issues from the list',
    body: 'Two customers have asked for it this quarter. Would be a multi-select and one action.',
    status: 'backlog',
    priority: 'low',
    labels: ['feature request'],
  },
  {
    title: 'Password reset link expired before it arrived',
    body: 'One-hour window against a mail provider that delayed delivery by ninety minutes. Resolved for the customer.',
    status: 'done',
    priority: 'medium',
    labels: ['question'],
  },
  {
    title: 'Customer cannot sign in after enabling two-factor',
    body: 'Recovery codes were never saved. Verified identity and reset the factor.',
    status: 'done',
    priority: 'urgent',
    labels: ['escalation'],
  },
]

const LABELS: Array<{ name: string; color: string; group?: string }> = [
  { name: 'bug', color: '#d64545', group: 'Kind' },
  { name: 'feature request', color: '#3f7fd8', group: 'Kind' },
  { name: 'question', color: '#8a6fd1', group: 'Kind' },
  { name: 'escalation', color: '#e0803a', group: 'Kind' },
  { name: 'website', color: '#3aa17e', group: 'Area' },
  { name: 'mobile', color: '#2f8fbf', group: 'Area' },
  { name: 'docs', color: '#6b8f3a', group: 'Area' },
  { name: 'content', color: '#b8873a', group: 'Area' },
  { name: 'performance', color: '#c05c8e', group: 'Area' },
  { name: 'security', color: '#8f4b4b', group: 'Area' },
]

export async function seedTrackerDemo(ctx: DemoSeedContext): Promise<DemoSeedSummary> {
  const { kernel, workspaceId, actor, now } = ctx
  const svc = trackerServices(kernel)

  return withWs(
    kernel,
    workspaceId,
    async (tx) => {
      /*
       * The idempotency guard, and the reason it reads the table rather than a marker: at-least-once
       * delivery means this can be asked twice, and a second pass must not drop a duplicate set of
       * projects into a workspace somebody has started using. "No projects" is the only honest
       * definition of an untouched tracker.
       */
      const [existing] = await tx.select({ id: projects.id }).from(projects).limit(1)
      if (existing) return { skipped: true }

      const labelIds = new Map<string, string>()
      for (const l of LABELS) {
        const label = await svc.planning.createLabel(tx, actor, workspaceId, {
          name: l.name,
          color: l.color,
          groupName: l.group ?? null,
        })
        labelIds.set(l.name, label.id)
      }

      let issues = 0
      let comments = 0
      let moved = 0

      const web = await svc.projects.create(tx, actor, workspaceId, {
        key: 'WEB',
        name: 'Website relaunch',
        description: 'Marketing site, docs and the blog. Ships in stages rather than all at once.',
        icon: 'globe',
        color: '#3aa17e',
        visibility: 'workspace',
        defaultAssignee: 'unassigned',
        template: 'marketing',
        memberIds: [],
      })
      const app = await svc.projects.create(tx, actor, workspaceId, {
        key: 'APP',
        name: 'Mobile app',
        description: 'iOS and Android, one release train, fortnightly cycles.',
        icon: 'smartphone',
        color: '#2f8fbf',
        visibility: 'workspace',
        defaultAssignee: 'unassigned',
        template: 'software',
        memberIds: [],
      })
      const sup = await svc.projects.create(tx, actor, workspaceId, {
        key: 'SUP',
        name: 'Customer support',
        description: 'Everything that arrives from a customer. Triaged daily.',
        icon: 'life-buoy',
        color: '#e0803a',
        visibility: 'workspace',
        defaultAssignee: 'unassigned',
        /*
         * `simple`, not `support`, and that is a workaround rather than a preference.
         *
         * A project template's custom fields are installed at **workspace** level (see
         * `ConfigService`'s note: a field key is unique per workspace, so scoping them to the
         * project would leave every later project's layouts pointing at fields it cannot see) — and
         * the support template marks `impact` `required` on the field definition itself.
         * `IssueService.create` reads exactly that flag, so from the moment a support project
         * exists, **every** issue in the workspace is refused without an Impact value: the demo died
         * on `"Impact" is required` while creating a website issue. A demo workspace whose next new
         * issue cannot be saved is worse than one with a plainer support project.
         *
         * The defect is in the tracker, not here, and the fix is a decision about which of the two
         * `required` flags is authoritative — the field's (workspace-wide, what is read today) or
         * the work-item type's field layout (per project, what is written and never read). That is
         * not a call a demo seeder should make.
         */
        template: 'simple',
        memberIds: [],
      })

      const componentIds = new Map<string, string>()
      for (const [project, names] of [
        [web, ['Marketing site', 'Documentation']],
        [app, ['Sync', 'Notifications', 'Accounts']],
      ] as Array<[Project, string[]]>)
        for (const name of names) {
          const c = await svc.planning.createComponent(tx, actor, workspaceId, project.id, { name })
          componentIds.set(name, c.id)
        }

      await svc.planning.createVersion(tx, actor, workspaceId, app.id, {
        name: '3.2',
        description: 'Offline mode and the notification fixes.',
        releaseDate: dateOnly(at(now, 18)),
      })
      await svc.planning.createMilestone(tx, actor, workspaceId, web.id, {
        name: 'Public launch',
        description: 'New pricing, home page and changelog live.',
        targetDate: dateOnly(at(now, 24)),
      })

      /*
       * Two cycles per delivery project: the one that just finished and the one running now. One
       * cycle alone leaves every burndown and velocity chart with a single point, which is exactly
       * the screen a demo is meant to show working.
       */
      const cycles = new Map<string, string>()
      for (const project of [web, app]) {
        await svc.planning.createCycle(tx, actor, workspaceId, project.id, {
          name: 'Cycle 1',
          goal: project.id === web.id ? 'Pricing and home page copy' : 'Notification reliability',
          startAt: at(now, -28).toISOString(),
          endAt: at(now, -14).toISOString(),
        })
        const current = await svc.planning.createCycle(tx, actor, workspaceId, project.id, {
          name: 'Cycle 2',
          goal: project.id === web.id ? 'Launch-ready pricing page' : 'Offline mode behind a flag',
          startAt: at(now, -4).toISOString(),
          endAt: at(now, 10).toISOString(),
        })
        cycles.set(project.id, current.id)
        await svc.planning.startCycle(tx, actor, workspaceId, current.id).catch(() => undefined)
      }

      for (const [project, seeds] of [
        [web, WEB],
        [app, APP],
        [sup, SUP],
      ] as Array<[Project, Seed[]]>) {
        const written = await writeIssues(tx, svc, ctx, project, seeds, {
          labelIds,
          componentIds,
          cycleId: cycles.get(project.id) ?? null,
        })
        issues += written.issues
        comments += written.comments
        moved += written.moved
      }

      return {
        created: { projects: 3, issues, moved, comments, labels: LABELS.length, cycles: 4 },
      }
    },
    ctx.actorId,
  )
}

async function writeIssues(
  tx: Tx,
  svc: TrackerServices,
  ctx: DemoSeedContext,
  project: Project,
  seeds: Seed[],
  refs: {
    labelIds: Map<string, string>
    componentIds: Map<string, string>
    cycleId: string | null
  },
): Promise<{ issues: number; comments: number; moved: number }> {
  const { workspaceId, actor, actorId, now } = ctx
  const [projectRow] = await tx.select().from(projects).where(eq(projects.id, project.id)).limit(1)
  if (!projectRow) return { issues: 0, comments: 0, moved: 0 }

  let issues = 0
  let comments = 0
  let moved = 0
  for (const seed of seeds) {
    const issue = await svc.issues.create(
      tx,
      actor,
      workspaceId,
      {
        projectId: project.id,
        title: seed.title,
        description: textToDoc(seed.body),
        priority: seed.priority,
        reporterId: actorId as never,
        assigneeIds: seed.status === 'backlog' ? [] : ([actorId] as never[]),
        labelIds: (seed.labels ?? []).map((n) => refs.labelIds.get(n)).filter((v): v is string => !!v),
        componentIds: seed.component
          ? [refs.componentIds.get(seed.component)].filter((v): v is string => !!v)
          : [],
        ...(seed.estimate === undefined ? {} : { estimate: seed.estimate }),
        ...(seed.due === undefined ? {} : { dueDate: dateOnly(at(now, seed.due)) }),
        ...(seed.inCycle && refs.cycleId ? { cycleId: refs.cycleId } : {}),
        ...(seed.custom ? { custom: seed.custom } : {}),
      },
      { system: true },
    )
    issues += 1

    /*
     * The status is set after creation rather than passed in, because a workflow decides which
     * statuses exist and `moveToStatus` is what writes the status history the cycle report and the
     * "time in status" column read. An issue dropped straight into `done` has a board position and
     * an empty history.
     */
    /*
     * The move is counted and not swallowed, which is the second half of the lesson above: the
     * first version caught every failure and returned nothing about it, so a seed that moved no
     * issue at all was indistinguishable from one that moved them all. `moved` is returned in the
     * summary and asserted in `demo.int.test.ts`, so this cannot go quiet again.
     */
    if (seed.status !== 'backlog') {
      const { definition } = await svc.config.workflowFor(tx, projectRow, issue.typeId)
      const target = definition.statuses.find((s) => s.category === seed.status)
      if (target && target.id !== issue.statusId) {
        await svc.transitions.moveToStatus(tx, actor, workspaceId, issue.id, target.id, {
          ...(seed.status === 'done' ? { resolution: 'done' } : {}),
          ...(seed.status === 'cancelled' ? { resolution: 'wontdo' } : {}),
        })
        moved += 1
      }
    }

    for (const body of seed.comments ?? []) {
      await svc.comments.create(tx, actor, workspaceId, issue.id, textToDoc(body), { silent: true })
      comments += 1
    }
  }
  return { issues, comments, moved }
}
