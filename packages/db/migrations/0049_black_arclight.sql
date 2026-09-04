ALTER TABLE "consignments" ADD COLUMN "planned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "discrepancy_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "discrepancy_note" text;--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "discrepancy_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "discrepancy_reply" text;--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "discrepancy_replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "invite_token_hash" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "invite_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "portal_last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "pending_bank_account" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "pending_bank_requested_at" timestamp with time zone;