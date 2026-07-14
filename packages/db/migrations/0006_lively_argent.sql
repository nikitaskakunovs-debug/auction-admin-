CREATE TABLE "pickup_ticket_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"picked_at" timestamp with time zone,
	"picked_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "pickup_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"day_key" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"checked_in_via" text DEFAULT 'desk' NOT NULL,
	"claimed_by_id" uuid,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"picking_started_at" timestamp with time zone,
	"delivering_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"actor_id" uuid,
	"actor_label" text DEFAULT 'System' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone" text NOT NULL,
	"aisle" text DEFAULT '' NOT NULL,
	"rack" text DEFAULT '' NOT NULL,
	"shelf" text DEFAULT '' NOT NULL,
	"label" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "pickup_deadline_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "restock_fee_bp" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "restock_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "pickup_ticket_items" ADD CONSTRAINT "pickup_ticket_items_ticket_id_pickup_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."pickup_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_ticket_items" ADD CONSTRAINT "pickup_ticket_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_ticket_items" ADD CONSTRAINT "pickup_ticket_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_ticket_items" ADD CONSTRAINT "pickup_ticket_items_picked_by_id_admin_users_id_fk" FOREIGN KEY ("picked_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_tickets" ADD CONSTRAINT "pickup_tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_tickets" ADD CONSTRAINT "pickup_tickets_claimed_by_id_admin_users_id_fk" FOREIGN KEY ("claimed_by_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_from_location_id_warehouse_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_to_location_id_warehouse_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_id_admin_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pickup_ticket_items_ticket_idx" ON "pickup_ticket_items" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_tickets_day_number_idx" ON "pickup_tickets" USING btree ("day_key","number");--> statement-breakpoint
CREATE INDEX "pickup_tickets_status_idx" ON "pickup_tickets" USING btree ("status","checked_in_at");--> statement-breakpoint
CREATE INDEX "pickup_tickets_customer_idx" ON "pickup_tickets" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_locations_label_idx" ON "warehouse_locations" USING btree ("label");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;