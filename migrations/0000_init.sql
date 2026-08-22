CREATE SCHEMA IF NOT EXISTS "mod_tracker";
--> statement-breakpoint
CREATE TABLE "mod_tracker"."attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."comment_reactions" (
	"comment_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_reactions_comment_id_user_id_emoji_pk" PRIMARY KEY("comment_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_id" uuid,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"mention_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body_text, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."components" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"lead_id" uuid,
	"default_assignee" text DEFAULT 'project' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."cycles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"goal" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"carry_over_count" integer DEFAULT 0 NOT NULL,
	"committed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."field_defs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_value" jsonb,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"searchable" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"show_in_cards" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."field_schemes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"field_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."hierarchy_rules" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"file_id" uuid NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."intake_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."issue_approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"transition_id" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."issue_counters" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"last_issue_number" integer DEFAULT 0 NOT NULL,
	"last_cycle_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."issue_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."issue_status_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"from_status_id" text,
	"to_status_id" text NOT NULL,
	"from_category" text,
	"to_category" text NOT NULL,
	"actor_id" uuid,
	"transition_id" text,
	"duration_sec" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."issue_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"type_id" uuid,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sub_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."issues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"number" integer NOT NULL,
	"type_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" jsonb,
	"description_text" text DEFAULT '' NOT NULL,
	"status_id" text NOT NULL,
	"status_category" text NOT NULL,
	"priority" text DEFAULT 'none' NOT NULL,
	"assignee_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reporter_id" uuid,
	"creator_id" uuid,
	"label_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"component_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"affects_version_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cycle_id" uuid,
	"milestone_id" uuid,
	"parent_id" uuid,
	"rank" text NOT NULL,
	"estimate" double precision,
	"estimate_unit" text DEFAULT 'points' NOT NULL,
	"start_date" date,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"resolution" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"watcher_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"time_spent_sec" integer DEFAULT 0 NOT NULL,
	"remaining_sec" integer,
	"original_estimate_sec" integer,
	"sla" jsonb,
	"triage" boolean DEFAULT false NOT NULL,
	"snoozed_until" timestamp with time zone,
	"source" text DEFAULT 'app' NOT NULL,
	"external_ref" text,
	"chat_channel_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description_text, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."labels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"color" text,
	"description" text,
	"group_name" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"kind" text DEFAULT 'generic' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."milestones" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."project_members" (
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."project_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"color" text,
	"lead_id" uuid,
	"visibility" text DEFAULT 'workspace' NOT NULL,
	"default_assignee" text DEFAULT 'unassigned' NOT NULL,
	"workflow_scheme_id" uuid,
	"type_scheme_id" uuid,
	"field_scheme_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"intake_token" text,
	"member_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."recurring_issues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_issue_id" uuid,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."relations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_issue_id" uuid NOT NULL,
	"to_issue_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."timers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."type_schemes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"default_type_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'unreleased' NOT NULL,
	"start_date" date,
	"release_date" date,
	"released_at" timestamp with time zone,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."view_pins" (
	"view_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "view_pins_view_id_user_id_pk" PRIMARY KEY("view_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"kql" text DEFAULT '' NOT NULL,
	"layout" text DEFAULT 'list' NOT NULL,
	"display" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"owner_id" uuid,
	"builtin" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."work_item_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"color" text,
	"level" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"workflow_id" uuid,
	"field_layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"template_body" jsonb,
	"order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."workflow_schemes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_workflow_id" uuid NOT NULL,
	"mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."workflows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."worklogs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_sec" integer NOT NULL,
	"note" text,
	"billable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_tracker"."workspaces" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_issue_file_uq" ON "mod_tracker"."attachments" USING btree ("issue_id","file_id");--> statement-breakpoint
CREATE INDEX "attachments_issue_idx" ON "mod_tracker"."attachments" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_issue_idx" ON "mod_tracker"."comments" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_thread_idx" ON "mod_tracker"."comments" USING btree ("parent_id","created_at") WHERE parent_id is not null;--> statement-breakpoint
CREATE INDEX "comments_search_idx" ON "mod_tracker"."comments" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "components_project_name_uq" ON "mod_tracker"."components" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_project_number_uq" ON "mod_tracker"."cycles" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "cycles_project_status_idx" ON "mod_tracker"."cycles" USING btree ("project_id","status","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "field_defs_ws_project_key_uq" ON "mod_tracker"."field_defs" USING btree ("workspace_id","project_id","key") WHERE project_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "field_defs_ws_key_uq" ON "mod_tracker"."field_defs" USING btree ("workspace_id","key") WHERE project_id is null;--> statement-breakpoint
CREATE INDEX "field_defs_ws_idx" ON "mod_tracker"."field_defs" USING btree ("workspace_id","project_id","order");--> statement-breakpoint
CREATE INDEX "field_schemes_ws_idx" ON "mod_tracker"."field_schemes" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "import_jobs_project_idx" ON "mod_tracker"."import_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_approvals_issue_transition_uq" ON "mod_tracker"."issue_approvals" USING btree ("issue_id","transition_id");--> statement-breakpoint
CREATE INDEX "issue_history_issue_idx" ON "mod_tracker"."issue_history" USING btree ("issue_id","occurred_at");--> statement-breakpoint
CREATE INDEX "issue_status_history_issue_idx" ON "mod_tracker"."issue_status_history" USING btree ("issue_id","occurred_at");--> statement-breakpoint
CREATE INDEX "issue_status_history_project_idx" ON "mod_tracker"."issue_status_history" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "issue_templates_ws_idx" ON "mod_tracker"."issue_templates" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_ws_key_uq" ON "mod_tracker"."issues" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_project_number_uq" ON "mod_tracker"."issues" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "issues_ws_project_rank_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","project_id","rank");--> statement-breakpoint
CREATE INDEX "issues_ws_project_status_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","project_id","status_id");--> statement-breakpoint
CREATE INDEX "issues_ws_updated_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "issues_ws_cycle_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","cycle_id") WHERE cycle_id is not null;--> statement-breakpoint
CREATE INDEX "issues_ws_parent_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","parent_id") WHERE parent_id is not null;--> statement-breakpoint
CREATE INDEX "issues_ws_due_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","due_date") WHERE due_date is not null;--> statement-breakpoint
CREATE INDEX "issues_ws_triage_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","project_id") WHERE triage;--> statement-breakpoint
CREATE INDEX "issues_external_ref_idx" ON "mod_tracker"."issues" USING btree ("workspace_id","external_ref") WHERE external_ref is not null;--> statement-breakpoint
CREATE INDEX "issues_assignees_idx" ON "mod_tracker"."issues" USING gin ("assignee_ids");--> statement-breakpoint
CREATE INDEX "issues_labels_idx" ON "mod_tracker"."issues" USING gin ("label_ids");--> statement-breakpoint
CREATE INDEX "issues_components_idx" ON "mod_tracker"."issues" USING gin ("component_ids");--> statement-breakpoint
CREATE INDEX "issues_versions_idx" ON "mod_tracker"."issues" USING gin ("version_ids");--> statement-breakpoint
CREATE INDEX "issues_watchers_idx" ON "mod_tracker"."issues" USING gin ("watcher_ids");--> statement-breakpoint
CREATE INDEX "issues_custom_idx" ON "mod_tracker"."issues" USING gin ("custom");--> statement-breakpoint
CREATE INDEX "issues_search_idx" ON "mod_tracker"."issues" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_project_name_uq" ON "mod_tracker"."labels" USING btree ("project_id","name") WHERE project_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_ws_name_uq" ON "mod_tracker"."labels" USING btree ("workspace_id","name") WHERE project_id is null;--> statement-breakpoint
CREATE INDEX "labels_ws_idx" ON "mod_tracker"."labels" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "links_issue_idx" ON "mod_tracker"."links" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "milestones_project_idx" ON "mod_tracker"."milestones" USING btree ("project_id","target_date");--> statement-breakpoint
CREATE INDEX "project_members_ws_user_idx" ON "mod_tracker"."project_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_templates_ws_key_uq" ON "mod_tracker"."project_templates" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_ws_key_uq" ON "mod_tracker"."projects" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_intake_token_uq" ON "mod_tracker"."projects" USING btree ("intake_token") WHERE intake_token is not null;--> statement-breakpoint
CREATE INDEX "projects_ws_idx" ON "mod_tracker"."projects" USING btree ("workspace_id","archived_at");--> statement-breakpoint
CREATE INDEX "recurring_issues_project_idx" ON "mod_tracker"."recurring_issues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "recurring_issues_due_idx" ON "mod_tracker"."recurring_issues" USING btree ("next_run_at") WHERE enabled;--> statement-breakpoint
CREATE UNIQUE INDEX "relations_edge_uq" ON "mod_tracker"."relations" USING btree ("from_issue_id","to_issue_id","type");--> statement-breakpoint
CREATE INDEX "relations_to_idx" ON "mod_tracker"."relations" USING btree ("to_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timers_ws_user_uq" ON "mod_tracker"."timers" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "type_schemes_ws_idx" ON "mod_tracker"."type_schemes" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "versions_project_idx" ON "mod_tracker"."versions" USING btree ("project_id","order");--> statement-breakpoint
CREATE INDEX "view_pins_ws_user_idx" ON "mod_tracker"."view_pins" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "views_ws_idx" ON "mod_tracker"."views" USING btree ("workspace_id","project_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_types_ws_project_key_uq" ON "mod_tracker"."work_item_types" USING btree ("workspace_id","project_id","key") WHERE project_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_types_ws_key_uq" ON "mod_tracker"."work_item_types" USING btree ("workspace_id","key") WHERE project_id is null;--> statement-breakpoint
CREATE INDEX "work_item_types_ws_idx" ON "mod_tracker"."work_item_types" USING btree ("workspace_id","project_id","order");--> statement-breakpoint
CREATE INDEX "workflow_schemes_ws_idx" ON "mod_tracker"."workflow_schemes" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workflows_ws_idx" ON "mod_tracker"."workflows" USING btree ("workspace_id","project_id","archived_at");--> statement-breakpoint
CREATE INDEX "worklogs_issue_idx" ON "mod_tracker"."worklogs" USING btree ("issue_id","started_at");--> statement-breakpoint
CREATE INDEX "worklogs_ws_user_started_idx" ON "mod_tracker"."worklogs" USING btree ("workspace_id","user_id","started_at");--> statement-breakpoint
CREATE INDEX "worklogs_project_started_idx" ON "mod_tracker"."worklogs" USING btree ("project_id","started_at");