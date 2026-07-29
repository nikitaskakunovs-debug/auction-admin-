CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "condition_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"condition_code" text NOT NULL,
	"text_lv" text NOT NULL,
	"text_ru" text NOT NULL,
	"text_en" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_comment_reads" (
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid,
	"author_label" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "condition_preset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "grade_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "graded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "graded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reviewed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "grade_reject_reason" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "grade_notice_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_comment_reads" ADD CONSTRAINT "item_comment_reads_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_comment_reads" ADD CONSTRAINT "item_comment_reads_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_comments" ADD CONSTRAINT "item_comments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_comments" ADD CONSTRAINT "item_comments_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "condition_presets_code_idx" ON "condition_presets" USING btree ("condition_code","position");--> statement-breakpoint
CREATE UNIQUE INDEX "item_comment_reads_pk" ON "item_comment_reads" USING btree ("user_id","item_id");--> statement-breakpoint
CREATE INDEX "item_comments_item_idx" ON "item_comments" USING btree ("item_id","created_at");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_graded_by_id_admin_users_id_fk" FOREIGN KEY ("graded_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_reviewed_by_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;