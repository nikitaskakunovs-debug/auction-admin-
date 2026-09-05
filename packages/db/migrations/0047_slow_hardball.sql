CREATE TABLE "approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_cents" integer DEFAULT 0 NOT NULL,
	"max_cents" integer,
	"approver" text DEFAULT 'auto' NOT NULL,
	"dual" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "approver_telegram" (
	"admin_user_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"link_code" text,
	"linked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "export_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount_cents" integer,
	"ref_type" text,
	"ref_id" text,
	"department" text,
	"status" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text,
	"resolution_note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"legal_entity" text DEFAULT 'LV' NOT NULL,
	"department" text,
	"payment_method" text,
	"order_ref" text,
	"ref_type" text,
	"ref_id" text,
	"memo" text DEFAULT '' NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"export_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "status" text DEFAULT 'closed' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "method" text DEFAULT 'card' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "paid_by" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "legal_entity" text DEFAULT 'LV' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "file_key" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "approval_status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "approval_rule_note" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "second_approved_by" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "second_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "rejected_reason" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "default_department" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "default_category" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "default_legal_entity" text;--> statement-breakpoint
ALTER TABLE "approver_telegram" ADD CONSTRAINT "approver_telegram_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approver_tg_chat_idx" ON "approver_telegram" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "fin_flags_status_idx" ON "fin_flags" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fin_flags_dedupe_idx" ON "fin_flags" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "ledger_account_idx" ON "ledger_entries" USING btree ("account","event_at");--> statement-breakpoint
CREATE INDEX "ledger_export_idx" ON "ledger_entries" USING btree ("export_batch_id");--> statement-breakpoint
CREATE INDEX "ledger_order_idx" ON "ledger_entries" USING btree ("order_ref");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "supplier_invoices_approval_idx" ON "supplier_invoices" USING btree ("approval_status");--> statement-breakpoint
-- ── Сиды финансового слоя (правятся из админки, это только старт) ──────────
-- Пороги апрува по разделу 10.3: до €200 авто; €200–1000 руководитель
-- (замените роль в админке на нужную); €1000–5000 владелец; €5000+ двойной.
INSERT INTO "approval_rules" ("min_cents","max_cents","approver","dual","position","updated_by") VALUES
 (0, 20000, 'auto', false, 0, 'seed'),
 (20000, 100000, 'role:operations', false, 1, 'seed - nomainiet lomu'),
 (100000, 500000, 'role:super_admin', false, 2, 'seed'),
 (500000, NULL, 'role:super_admin', true, 3, 'seed');
--> statement-breakpoint
-- Новые права: супер-админу все, роли finance — операционный набор.
-- Только для СУЩЕСТВУЮЩИХ ролей: на свежей базе admin_roles ещё пуст
-- (роли сеет seedDatabase ПОСЛЕ миграций и берёт права из domain-конфига),
-- а на живом сервере роли есть — и им нужно донести новые права.
INSERT INTO "role_permissions" ("role_id","permission")
SELECT r.id, v.perm
FROM "admin_roles" r
JOIN (VALUES
 ('super_admin','fin.flags_view'),('super_admin','fin.flags_resolve'),
 ('super_admin','fin.refunds_manage'),('super_admin','fin.ledger_view'),
 ('super_admin','fin.export'),('super_admin','fin.approvals_view'),
 ('super_admin','fin.approve'),('super_admin','fin.rules_edit'),
 ('finance','fin.flags_view'),('finance','fin.flags_resolve'),
 ('finance','fin.refunds_manage'),('finance','fin.ledger_view'),
 ('finance','fin.export'),('finance','fin.approvals_view')
) AS v(role_id, perm) ON v.role_id = r.id
ON CONFLICT DO NOTHING;
