CREATE TABLE "admin_user" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"ip_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "api_key_grant" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"api_key_id" bigint NOT NULL,
	"datasource_id" bigint NOT NULL,
	"can_read" boolean DEFAULT false NOT NULL,
	"can_write" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" bigint,
	"actor_name" text NOT NULL,
	"api_key_id" bigint,
	"api_key_prefix" text,
	"datasource_id" bigint,
	"datasource_name" text,
	"engine" text,
	"action" text NOT NULL,
	"tool_name" text,
	"sql_text" text,
	"classification" text,
	"decision" text NOT NULL,
	"denial_reason" text,
	"row_count" integer,
	"duration_ms" integer,
	"client_ip" "inet",
	"error_code" text,
	"error_message" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datasource" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"database_name" text NOT NULL,
	"username" text NOT NULL,
	"password_ciphertext" text NOT NULL,
	"connect_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasource_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"client_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_admin_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_grant" ADD CONSTRAINT "api_key_grant_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_grant" ADD CONSTRAINT "api_key_grant_datasource_id_datasource_id_fk" FOREIGN KEY ("datasource_id") REFERENCES "public"."datasource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_admin_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_status_idx" ON "api_key" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_grant_key_datasource_uq" ON "api_key_grant" USING btree ("api_key_id","datasource_id");--> statement-breakpoint
CREATE INDEX "api_key_grant_datasource_idx" ON "api_key_grant" USING btree ("datasource_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_key_created_idx" ON "audit_log" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_datasource_created_idx" ON "audit_log" USING btree ("datasource_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_decision_created_idx" ON "audit_log" USING btree ("decision","created_at");--> statement-breakpoint
CREATE INDEX "session_user_expires_idx" ON "session" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");