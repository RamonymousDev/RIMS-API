CREATE TYPE "public"."position_type" AS ENUM('top', 'bottom');--> statement-breakpoint
CREATE TABLE "item_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"line" text NOT NULL,
	"column" integer NOT NULL,
	"row" integer NOT NULL,
	"position" "position_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_mappings" ADD CONSTRAINT "item_mappings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_mappings_location_idx" ON "item_mappings" USING btree ("line","column","row","position");--> statement-breakpoint
CREATE INDEX "item_mappings_item_idx" ON "item_mappings" USING btree ("item_id");