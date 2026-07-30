CREATE TABLE "bug_report_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"author_id" uuid,
	"author_label" text NOT NULL,
	"side" text NOT NULL,
	"jira_comment_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bug_report_reads" (
	"user_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bug_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid,
	"reporter_label" text NOT NULL,
	"screen" text DEFAULT '' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"steps" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'bug' NOT NULL,
	"severity" text DEFAULT 'normal' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"console_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"jira_key" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"notice_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report_comments" ADD CONSTRAINT "bug_report_comments_report_id_bug_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_comments" ADD CONSTRAINT "bug_report_comments_author_id_admin_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_reads" ADD CONSTRAINT "bug_report_reads_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_reads" ADD CONSTRAINT "bug_report_reads_report_id_bug_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_reporter_id_admin_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bug_report_comments_report_idx" ON "bug_report_comments" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bug_report_reads_pk" ON "bug_report_reads" USING btree ("user_id","report_id");--> statement-breakpoint
CREATE INDEX "bug_reports_reporter_idx" ON "bug_reports" USING btree ("reporter_id","created_at");--> statement-breakpoint
CREATE INDEX "bug_reports_status_idx" ON "bug_reports" USING btree ("status");