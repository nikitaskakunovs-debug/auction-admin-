ALTER TABLE "markets" ALTER COLUMN "pickup_deadline_days" SET DEFAULT 30;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "storage_charged_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Окно самовывоза выросло с 14 до 30 дней: теперь неполученный заказ не
-- отменяется молча через две недели, а копит плату за хранение и живёт
-- дольше — у человека больше шансов забрать вещь. Трогаем только рынки,
-- оставшиеся на прежнем умолчании: осознанно выставленный срок — решение
-- владельца, и переписывать его миграция не вправе.
UPDATE "markets" SET "pickup_deadline_days" = 30 WHERE "pickup_deadline_days" = 14;
