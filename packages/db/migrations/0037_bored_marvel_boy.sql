CREATE TABLE "billing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text DEFAULT 'person' NOT NULL,
	"name" text NOT NULL,
	"reg_no" text DEFAULT '' NOT NULL,
	"vat_no" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"zip" text DEFAULT '' NOT NULL,
	"country" text DEFAULT 'LV' NOT NULL,
	"invoice_email" text DEFAULT '' NOT NULL,
	"vies" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_profiles_customer_idx" ON "billing_profiles" USING btree ("customer_id","archived_at");