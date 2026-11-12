CREATE TABLE "media_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_size" integer DEFAULT 0 NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_chunks" (
	"media_id" text NOT NULL,
	"byte_offset" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	CONSTRAINT "media_chunks_media_id_byte_offset_pk" PRIMARY KEY("media_id","byte_offset")
);
--> statement-breakpoint
CREATE TABLE "media_usage" (
	"user_id" text PRIMARY KEY NOT NULL,
	"total_bytes" integer NOT NULL,
	"asset_count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_chunks" ADD CONSTRAINT "media_chunks_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_usage" ADD CONSTRAINT "media_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_user_touched_idx" ON "media_assets" USING btree ("user_id","touched_at");