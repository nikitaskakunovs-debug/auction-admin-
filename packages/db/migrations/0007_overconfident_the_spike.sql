CREATE TABLE "customer_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_ref" text NOT NULL,
	"type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'outstanding' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"settled_by_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_fees" ADD CONSTRAINT "customer_fees_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_fees" ADD CONSTRAINT "customer_fees_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_fees" ADD CONSTRAINT "customer_fees_settled_by_id_admin_users_id_fk" FOREIGN KEY ("settled_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_fees_customer_idx" ON "customer_fees" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "customer_fees_order_idx" ON "customer_fees" USING btree ("order_id");