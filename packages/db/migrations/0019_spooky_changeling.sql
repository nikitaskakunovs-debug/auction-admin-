CREATE TABLE "worker_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day_key" text NOT NULL,
	"status" text DEFAULT 'working' NOT NULL,
	"since_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pickup_tickets" ADD COLUMN "pass_to_id" uuid;--> statement-breakpoint
ALTER TABLE "pickup_tickets" ADD COLUMN "pass_reason" text;--> statement-breakpoint
ALTER TABLE "pickup_tickets" ADD COLUMN "pass_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_status" ADD CONSTRAINT "worker_status_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_status_user_day_idx" ON "worker_status" USING btree ("user_id","day_key");--> statement-breakpoint
ALTER TABLE "pickup_tickets" ADD CONSTRAINT "pickup_tickets_pass_to_id_admin_users_id_fk" FOREIGN KEY ("pass_to_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;