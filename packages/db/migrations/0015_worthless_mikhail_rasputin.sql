ALTER TABLE "markets" ADD COLUMN "handling_fee_cents" integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "handling_cents" integer DEFAULT 0 NOT NULL;