CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'omniva' NOT NULL,
	"barcode" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"provider_status" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"label_printed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "omniva_pm_price_cents" integer DEFAULT 399 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfilment" text DEFAULT 'pickup' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_to" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "recipient_phone" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_barcode_idx" ON "shipments" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");