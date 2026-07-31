ALTER TABLE "stock_count_scans" DROP CONSTRAINT "stock_count_scans_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "stock_count_scans" ADD CONSTRAINT "stock_count_scans_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_location_idx" ON "items" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "items_consignment_idx" ON "items" USING btree ("consignment_id");