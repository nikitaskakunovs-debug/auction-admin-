ALTER TABLE "orders" ADD COLUMN "pickup_proxy_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "insurance_cents" integer DEFAULT 0 NOT NULL;