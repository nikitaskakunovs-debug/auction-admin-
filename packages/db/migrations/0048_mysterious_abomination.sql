ALTER TABLE "notifications" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "contact_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "lang" text DEFAULT 'lv' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "model" text DEFAULT 'buyout' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "commission_bp" integer DEFAULT 0 NOT NULL;