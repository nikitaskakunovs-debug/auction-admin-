CREATE TABLE "return_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"order_id" uuid NOT NULL,
	"order_ref" text NOT NULL,
	"item_id" uuid,
	"customer_id" uuid,
	"customer_alias" text DEFAULT '' NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decision" text,
	"refund_cents" integer DEFAULT 0 NOT NULL,
	"destination" text,
	"refund_method" text,
	"within_window" boolean DEFAULT true NOT NULL,
	"override_reason" text DEFAULT '' NOT NULL,
	"opened_by_id" uuid,
	"opened_by_label" text NOT NULL,
	"resolved_by_id" uuid,
	"resolved_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_opened_by_id_admin_users_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_cases" ADD CONSTRAINT "return_cases_resolved_by_id_admin_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "return_cases_ref_idx" ON "return_cases" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "return_cases_status_idx" ON "return_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "return_cases_customer_idx" ON "return_cases" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "return_cases_order_idx" ON "return_cases" USING btree ("order_id");