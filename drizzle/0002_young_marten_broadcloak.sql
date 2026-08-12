ALTER TABLE "items" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "date" date DEFAULT CURRENT_DATE NOT NULL;