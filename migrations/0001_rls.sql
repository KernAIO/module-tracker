-- Row level security for every tenant table of the tracker module.
-- Generated from `TENANT_TABLES` in src/server/schema.ts with `rlsPolicySql()` from @kernhq/kernel:
-- each table is readable and writable only while `app.workspace_id` (set by
-- `kernel.database.withWorkspace`) matches the row. There is no cross-workspace escape hatch.
alter table "mod_tracker"."projects" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."projects" force row level security;
--> statement-breakpoint
create policy "projects_ws_isolation" on "mod_tracker"."projects"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."issue_counters" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."issue_counters" force row level security;
--> statement-breakpoint
create policy "issue_counters_ws_isolation" on "mod_tracker"."issue_counters"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."project_members" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."project_members" force row level security;
--> statement-breakpoint
create policy "project_members_ws_isolation" on "mod_tracker"."project_members"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."project_templates" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."project_templates" force row level security;
--> statement-breakpoint
create policy "project_templates_ws_isolation" on "mod_tracker"."project_templates"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."work_item_types" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."work_item_types" force row level security;
--> statement-breakpoint
create policy "work_item_types_ws_isolation" on "mod_tracker"."work_item_types"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."type_schemes" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."type_schemes" force row level security;
--> statement-breakpoint
create policy "type_schemes_ws_isolation" on "mod_tracker"."type_schemes"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."hierarchy_rules" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."hierarchy_rules" force row level security;
--> statement-breakpoint
create policy "hierarchy_rules_ws_isolation" on "mod_tracker"."hierarchy_rules"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."field_defs" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."field_defs" force row level security;
--> statement-breakpoint
create policy "field_defs_ws_isolation" on "mod_tracker"."field_defs"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."field_schemes" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."field_schemes" force row level security;
--> statement-breakpoint
create policy "field_schemes_ws_isolation" on "mod_tracker"."field_schemes"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."workflows" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."workflows" force row level security;
--> statement-breakpoint
create policy "workflows_ws_isolation" on "mod_tracker"."workflows"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."workflow_schemes" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."workflow_schemes" force row level security;
--> statement-breakpoint
create policy "workflow_schemes_ws_isolation" on "mod_tracker"."workflow_schemes"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."issues" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."issues" force row level security;
--> statement-breakpoint
create policy "issues_ws_isolation" on "mod_tracker"."issues"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."comments" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."comments" force row level security;
--> statement-breakpoint
create policy "comments_ws_isolation" on "mod_tracker"."comments"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."comment_reactions" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."comment_reactions" force row level security;
--> statement-breakpoint
create policy "comment_reactions_ws_isolation" on "mod_tracker"."comment_reactions"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."relations" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."relations" force row level security;
--> statement-breakpoint
create policy "relations_ws_isolation" on "mod_tracker"."relations"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."attachments" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."attachments" force row level security;
--> statement-breakpoint
create policy "attachments_ws_isolation" on "mod_tracker"."attachments"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."links" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."links" force row level security;
--> statement-breakpoint
create policy "links_ws_isolation" on "mod_tracker"."links"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."issue_history" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."issue_history" force row level security;
--> statement-breakpoint
create policy "issue_history_ws_isolation" on "mod_tracker"."issue_history"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."issue_status_history" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."issue_status_history" force row level security;
--> statement-breakpoint
create policy "issue_status_history_ws_isolation" on "mod_tracker"."issue_status_history"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."issue_approvals" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."issue_approvals" force row level security;
--> statement-breakpoint
create policy "issue_approvals_ws_isolation" on "mod_tracker"."issue_approvals"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."issue_templates" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."issue_templates" force row level security;
--> statement-breakpoint
create policy "issue_templates_ws_isolation" on "mod_tracker"."issue_templates"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."recurring_issues" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."recurring_issues" force row level security;
--> statement-breakpoint
create policy "recurring_issues_ws_isolation" on "mod_tracker"."recurring_issues"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."cycles" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."cycles" force row level security;
--> statement-breakpoint
create policy "cycles_ws_isolation" on "mod_tracker"."cycles"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."milestones" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."milestones" force row level security;
--> statement-breakpoint
create policy "milestones_ws_isolation" on "mod_tracker"."milestones"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."versions" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."versions" force row level security;
--> statement-breakpoint
create policy "versions_ws_isolation" on "mod_tracker"."versions"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."components" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."components" force row level security;
--> statement-breakpoint
create policy "components_ws_isolation" on "mod_tracker"."components"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."labels" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."labels" force row level security;
--> statement-breakpoint
create policy "labels_ws_isolation" on "mod_tracker"."labels"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."views" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."views" force row level security;
--> statement-breakpoint
create policy "views_ws_isolation" on "mod_tracker"."views"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."view_pins" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."view_pins" force row level security;
--> statement-breakpoint
create policy "view_pins_ws_isolation" on "mod_tracker"."view_pins"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."worklogs" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."worklogs" force row level security;
--> statement-breakpoint
create policy "worklogs_ws_isolation" on "mod_tracker"."worklogs"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."timers" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."timers" force row level security;
--> statement-breakpoint
create policy "timers_ws_isolation" on "mod_tracker"."timers"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
alter table "mod_tracker"."import_jobs" enable row level security;
--> statement-breakpoint
alter table "mod_tracker"."import_jobs" force row level security;
--> statement-breakpoint
create policy "import_jobs_ws_isolation" on "mod_tracker"."import_jobs"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
