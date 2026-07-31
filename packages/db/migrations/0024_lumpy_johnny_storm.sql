CREATE TABLE "stock_count_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_id" uuid NOT NULL,
	"code" text NOT NULL,
	"item_id" uuid,
	"location_id" uuid NOT NULL,
	"scanned_by_id" uuid,
	"scanned_by_label" text DEFAULT '' NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"done_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "extra_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "cost_cents" integer;--> statement-breakpoint
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_count_id_stock_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."stock_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_scanned_by_id_admin_users_id_fk" FOREIGN KEY ("scanned_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_id_admin_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approved_by_id_admin_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_count_scans_count_idx" ON "stock_count_scans" USING btree ("count_id");--> statement-breakpoint
CREATE INDEX "stock_counts_status_idx" ON "stock_counts" USING btree ("status");