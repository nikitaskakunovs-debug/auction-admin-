ALTER TABLE "markets" ADD COLUMN "courier_price_cents" integer DEFAULT 690 NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "insurance_bp" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "insurance_min_cents" integer DEFAULT 100 NOT NULL;