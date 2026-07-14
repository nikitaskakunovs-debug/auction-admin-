ALTER TABLE "customers" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "condition_notes" text DEFAULT '' NOT NULL;