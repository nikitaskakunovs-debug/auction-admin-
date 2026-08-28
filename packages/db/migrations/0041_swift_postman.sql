CREATE TABLE "watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"auction_id" uuid,
	"listing_id" uuid,
	"ending_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_one_target" CHECK (("auction_id" IS NOT NULL) <> ("listing_id" IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_pair_idx" ON "watchlist" USING btree ("customer_id","auction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_listing_pair_idx" ON "watchlist" USING btree ("customer_id","listing_id");--> statement-breakpoint
CREATE INDEX "watchlist_auction_idx" ON "watchlist" USING btree ("auction_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_bounced_at" timestamp with time zone;
