CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"pin" text,
	"store_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"store_id" text,
	"store_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"device_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"address" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"category_id" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"publish_to_store_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" text NOT NULL,
	"sku_code" text NOT NULL,
	"name" text NOT NULL,
	"price" integer NOT NULL,
	"stock_tracked" boolean DEFAULT false NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"terminal_id" text NOT NULL,
	"order_number" text NOT NULL,
	"business_date" text NOT NULL,
	"state" text NOT NULL,
	"payment_state" text NOT NULL,
	"subtotal" integer DEFAULT 0 NOT NULL,
	"discount_total" integer DEFAULT 0 NOT NULL,
	"tax_total" integer DEFAULT 0 NOT NULL,
	"grand_total" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"discount_amount" integer DEFAULT 0 NOT NULL,
	"modifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"method" text NOT NULL,
	"payment_provider" text NOT NULL,
	"provider_transaction_id" text,
	"authorization_code" text,
	"amount" integer NOT NULL,
	"status" text NOT NULL,
	"settlement_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text NOT NULL,
	"invoice_number" text NOT NULL,
	"amount" integer NOT NULL,
	"payment_amount" integer DEFAULT 0 NOT NULL,
	"upload_state" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"mig_version" text,
	"turnkey_version" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"store_id" text,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload_fingerprint" text,
	"last_error_code" text,
	"last_error_message" text,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"actor" text NOT NULL,
	"user_id" text NOT NULL,
	"user_role" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"device_id" text,
	"user_agent" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency" (
	"key" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "users_tenant_email_idx" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "sessions_tenant_idx" ON "sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "products_tenant_idx" ON "products" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "skus_tenant_idx" ON "skus" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_store_idx" ON "orders" USING btree ("tenant_id","store_id");--> statement-breakpoint
CREATE INDEX "orders_paid_at_idx" ON "orders" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "outbox_state_idx" ON "outbox_jobs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "audit_tenant_action_idx" ON "audit_logs" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "audit_timestamp_idx" ON "audit_logs" USING btree ("timestamp");