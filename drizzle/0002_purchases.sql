CREATE TABLE "credit_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"credits" integer NOT NULL,
	"amount_atomic" text NOT NULL,
	"network" text NOT NULL,
	"asset" text NOT NULL,
	"pay_to" text NOT NULL,
	"payer" text NOT NULL,
	"nonce" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_purchases_tx_hash_uq" ON "credit_purchases" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_purchases_auth_uq" ON "credit_purchases" USING btree ("network","payer","nonce");--> statement-breakpoint
CREATE INDEX "credit_purchases_status_idx" ON "credit_purchases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "credit_purchases_user_idx" ON "credit_purchases" USING btree ("user_id","created_at");