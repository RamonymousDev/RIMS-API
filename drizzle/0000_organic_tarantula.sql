CREATE TYPE "public"."transaction_type" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TABLE "counters" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"model" text,
	"variant" text,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"min_stock" integer DEFAULT 0 NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"type" "transaction_type" NOT NULL,
	"note" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_items" ADD CONSTRAINT "transaction_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "items_sku_idx" ON "items" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "items_idempotency_key_idx" ON "items" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "items_name_trgm_idx" ON "items" USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "items_sku_trgm_idx" ON "items" USING gin (sku gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "transaction_items_transaction_idx" ON "transaction_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_items_item_idx" ON "transaction_items" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_items_unique_line" ON "transaction_items" USING btree ("transaction_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_number_idx" ON "transactions" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_idempotency_key_idx" ON "transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "transactions_type_created_idx" ON "transactions" USING btree ("type","created_at");