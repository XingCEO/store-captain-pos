-- Postgres row-level-security policies for tenant isolation.
--
-- Apply AFTER `drizzle-kit generate` produces the initial schema migration
-- and AFTER you `CREATE ROLE ulw_app LOGIN ...` for the application user.
--
-- All tenant-scoped tables enforce: row.tenant_id = current_setting('app.tenant_id').
-- The application MUST set this via `SET LOCAL app.tenant_id = $1` inside every
-- request transaction (derived from the authenticated session — NEVER from client input).
--
-- FORCE ROW LEVEL SECURITY is mandatory in production so superusers and the
-- table owner are also constrained by the policies.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'sessions', 'stores',
    'products', 'skus',
    'orders', 'order_items', 'payments', 'invoices',
    'outbox_jobs', 'audit_logs', 'idempotency'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true));',
      t, t
    );
  END LOOP;
END $$;

-- Tenants table is read-only from the app via a function or a separate role.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_self ON tenants
  USING (id = current_setting('app.tenant_id', true));

-- Helper for the app to set the tenant context inside a transaction:
--   SELECT set_config('app.tenant_id', $1, true);
-- (The `true` makes it transaction-local.)
