import type { Kernel } from '@kernhq/kernel'
import { AccessService } from './access.js'
import { CommentService } from './comments.js'
import { ConfigService } from './config.js'
import { ImportService } from './imports.js'
import { IntakeService } from './intake.js'
import { IssueService } from './issues.js'
import { LayoutService } from './layout.js'
import { NotifyService } from './notify.js'
import { PlanningService } from './planning.js'
import { ProjectService } from './projects.js'
import { QueryService } from './query.js'
import { ReportService } from './reports.js'
import { TimeService } from './time.js'
import { TransitionService } from './transitions.js'
import { ViewService } from './views.js'

export interface TrackerServices {
  access: AccessService
  notify: NotifyService
  config: ConfigService
  layout: LayoutService
  projects: ProjectService
  issues: IssueService
  comments: CommentService
  transitions: TransitionService
  query: QueryService
  planning: PlanningService
  views: ViewService
  time: TimeService
  reports: ReportService
  intake: IntakeService
  imports: ImportService
}

const cache = new WeakMap<Kernel, TrackerServices>()

/** One service graph per kernel instance; the router, jobs and procedures all share it. */
export function trackerServices(kernel: Kernel): TrackerServices {
  const existing = cache.get(kernel)
  if (existing) return existing

  const access = new AccessService(kernel)
  const notify = new NotifyService(kernel)
  const config = new ConfigService(kernel, access, notify)
  const layout = new LayoutService(config)
  const projects = new ProjectService(kernel, access, config, notify)
  const issues = new IssueService(kernel, access, config, notify)
  const comments = new CommentService(kernel, access, issues, notify)
  const transitions = new TransitionService(kernel, access, config, issues, notify)
  transitions.comments = comments
  const query = new QueryService(kernel, access, config, issues)
  const planning = new PlanningService(kernel, access, notify)
  const views = new ViewService(kernel, access, notify)
  const time = new TimeService(kernel, access, issues, notify)
  const reports = new ReportService(kernel, access, config, planning, time)
  const intake = new IntakeService(kernel, access, config, layout, issues, comments, transitions, notify)
  const imports = new ImportService(kernel, access, config, issues, planning)

  const services: TrackerServices = {
    access,
    notify,
    config,
    layout,
    projects,
    issues,
    comments,
    transitions,
    query,
    planning,
    views,
    time,
    reports,
    intake,
    imports,
  }
  cache.set(kernel, services)
  return services
}

export * from './db.js'
export {
  AccessService,
  CommentService,
  ConfigService,
  ImportService,
  IntakeService,
  IssueService,
  NotifyService,
  PlanningService,
  ProjectService,
  QueryService,
  ReportService,
  TimeService,
  TransitionService,
  ViewService,
}
