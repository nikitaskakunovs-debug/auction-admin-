ALTER TABLE "customers" ADD COLUMN "attribution_last" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "attribution_touches" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "visitor_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_login_method" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "attribution_last" jsonb;--> statement-breakpoint
CREATE INDEX "customers_visitor_idx" ON "customers" USING btree ("visitor_id");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id","created_at");
