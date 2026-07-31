CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"consignment_id" uuid,
	"number" text NOT NULL,
	"invoice_date" timestamp with time zone NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'unpaid' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"method" text DEFAULT 'bank_transfer' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"actor_id" uuid,
	"actor_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"reg_no" text DEFAULT '' NOT NULL,
	"vat_no" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"bank_account" text DEFAULT '' NOT NULL,
	"payment_terms_days" integer DEFAULT 14 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consignments" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_consignment_id_consignments_id_fk" FOREIGN KEY ("consignment_id") REFERENCES "public"."consignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_created_by_id_admin_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_actor_id_admin_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_id_admin_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoices_status_idx" ON "supplier_invoices" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "supplier_invoices_supplier_idx" ON "supplier_invoices" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_consignment_idx" ON "supplier_invoices" USING btree ("consignment_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_invoice_idx" ON "supplier_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_idx" ON "suppliers" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "suppliers_active_idx" ON "suppliers" USING btree ("active");--> statement-breakpoint
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill: every supplier name typed on a past delivery becomes a record.
-- Names are matched case- and whitespace-insensitively, so "Nordic Trade OÜ",
-- "nordic trade oü" and " Nordic Trade OÜ " collapse into one supplier; the
-- longest spelling wins as the display name because it is the least likely to
-- be the abbreviated one. Deliveries keep their original `supplier` text, so
-- nothing already printed or exported changes.
INSERT INTO "suppliers" ("name")
SELECT DISTINCT ON (lower(btrim("supplier"))) btrim("supplier")
FROM "consignments"
WHERE btrim("supplier") <> ''
ORDER BY lower(btrim("supplier")), length(btrim("supplier")) DESC;--> statement-breakpoint
UPDATE "consignments" c
SET "supplier_id" = s."id"
FROM "suppliers" s
WHERE lower(btrim(c."supplier")) = lower(s."name") AND c."supplier_id" IS NULL;