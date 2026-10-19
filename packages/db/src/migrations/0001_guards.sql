-- 本文件是手工编排的 SQL，drizzle-kit 不生成它（--custom）。
-- 两类内容：审计只增不改的结构性保证，以及 schema 里表达不出来的取值约束。

-- 1) 审计只增不改。
-- 应用层不提供更新/删除入口，但「不存在该能力」若只靠应用层自觉，一次绕过就失效了。
-- 存储层兜底：任何 UPDATE / DELETE / TRUNCATE 直接报错。
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log 只增不改，禁止 % 操作', TG_OP;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_append_only ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
-- TRUNCATE 不触发行级触发器，得单独用语句级触发器拦，否则「结构性只增」有个明面缺口。
CREATE OR REPLACE FUNCTION audit_log_append_only_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log 只增不改，禁止 % 操作', TG_OP;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_append_only_truncate ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_log_append_only_truncate();
--> statement-breakpoint

-- 2) 取值约束。用 text + CHECK 而不是 PG enum：加引擎/加动作只改一行约束，不必 ALTER TYPE。
ALTER TABLE "datasource" ADD CONSTRAINT "datasource_engine_check"
  CHECK ("engine" IN ('postgres', 'mysql'));
--> statement-breakpoint
ALTER TABLE "datasource" ADD CONSTRAINT "datasource_port_check"
  CHECK ("port" BETWEEN 1 AND 65535);
--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_status_check"
  CHECK ("status" IN ('active', 'disabled', 'revoked'));
--> statement-breakpoint
ALTER TABLE "api_key_grant" ADD CONSTRAINT "api_key_grant_has_permission_check"
  CHECK ("can_read" OR "can_write");
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_kind_check"
  CHECK ("actor_kind" IN ('admin', 'agent'));
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_decision_check"
  CHECK ("decision" IN ('granted', 'denied'));
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_classification_check"
  CHECK ("classification" IS NULL OR "classification" IN ('read', 'write', 'denied'));
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_check"
  CHECK ("action" IN (
    'auth.login', 'auth.login_failed', 'auth.logout',
    'datasource.create', 'datasource.update', 'datasource.delete', 'datasource.test',
    'api_key.create', 'api_key.update', 'api_key.grants', 'api_key.revoke',
    'mcp.list_datasources', 'mcp.list_tables', 'mcp.describe_table',
    'mcp.query', 'mcp.execute', 'mcp.unknown_tool'
  ));
--> statement-breakpoint
-- 拒绝必须说得出理由；通过则不该带理由。这条约束让「记了拒绝但没记原因」无法入库。
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_denial_reason_check"
  CHECK (("decision" = 'denied') = ("denial_reason" IS NOT NULL));
