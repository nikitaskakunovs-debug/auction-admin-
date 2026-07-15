CREATE TABLE "consignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"supplier" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"market_code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expected_count" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "consignment_id" uuid;--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_market_code_markets_code_fk" FOREIGN KEY ("market_code") REFERENCES "public"."markets"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_created_by_id_admin_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consignments_ref_idx" ON "consignments" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "consignments_status_idx" ON "consignments" USING btree ("status");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_consignment_id_consignments_id_fk" FOREIGN KEY ("consignment_id") REFERENCES "public"."consignments"("id") ON DELETE no action ON UPDATE no action;