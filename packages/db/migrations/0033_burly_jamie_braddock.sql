CREATE TABLE "credit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"order_ref" text,
	"note" text DEFAULT '' NOT NULL,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"balance_cents" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"customer_id" uuid NOT NULL,
	"event" text NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"push" boolean DEFAULT false NOT NULL,
	"telegram" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_refresh_tokens" ADD COLUMN "ua" text;--> statement-breakpoint
ALTER TABLE "customer_refresh_tokens" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "customer_refresh_tokens" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_verify_token_hash" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_verify_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_credit_id_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."credits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credits" ADD CONSTRAINT "credits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_entries_credit_idx" ON "credit_entries" USING btree ("credit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credits_customer_idx" ON "credits" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_pk" ON "notification_prefs" USING btree ("customer_id","event");--> statement-breakpoint
-- Существующие клиенты уже торговали до появления проверки почты — их адреса
-- считаем подтверждёнными задним числом, иначе проверка заперла бы прод.
UPDATE "customers" SET "email_verified_at" = now() WHERE "email_verified_at" IS NULL;
