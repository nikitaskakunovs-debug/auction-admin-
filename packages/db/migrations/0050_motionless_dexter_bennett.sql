CREATE TABLE "cart_reminders" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"touched_at" timestamp with time zone NOT NULL,
	"listing_id" uuid,
	"item_count" integer DEFAULT 0 NOT NULL,
	"stage" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_price_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"old_price_cents" integer NOT NULL,
	"new_price_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"recipients" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cart_reminders" ADD CONSTRAINT "cart_reminders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_reminders" ADD CONSTRAINT "cart_reminders_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_price_drops" ADD CONSTRAINT "listing_price_drops_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cart_reminders_due_idx" ON "cart_reminders" USING btree ("stage","touched_at");--> statement-breakpoint
CREATE INDEX "listing_price_drops_pending_idx" ON "listing_price_drops" USING btree ("notified_at","created_at");