ALTER TABLE "ad_cards" ADD COLUMN "kind" text DEFAULT 'banner' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_cards" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_cards" ADD COLUMN "video_url" text;--> statement-breakpoint
ALTER TABLE "ad_cards" ADD COLUMN "show_label" boolean DEFAULT true NOT NULL;