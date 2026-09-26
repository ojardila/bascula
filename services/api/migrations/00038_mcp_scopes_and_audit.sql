-- +goose Up
-- +goose StatementBegin

-- MCP security review (docs/mcp/security.md).
--
-- 1. A grant may be read-only. The scope an assistant was granted at consent
--    ("mcp" = consult and register, "mcp:read" = consult only) travels with
--    its refresh-token family, so rotation keeps it. NULL is every family
--    issued before scopes existed, and means what those grants always meant:
--    full access for the member's role. A web or handset family has none.
ALTER TABLE refresh_tokens ADD COLUMN scope text;

-- 2. The per-address registration limit, counted where every replica sees
--    it. The address is the rate-limit bucket (an IPv6 /64), not a person.
ALTER TABLE oauth_clients ADD COLUMN registered_from text NOT NULL DEFAULT '';
CREATE INDEX ix_oauth_clients_created ON oauth_clients (created_at);

-- 3. What assistants wrote: one row per write-tool execution (not previews),
--    who, through which OAuth client, which tool, the outcome and the
--    arguments as the assistant sent them. The owner and the administrator
--    read it in «Conexiones»; nobody updates or deletes it.
CREATE TABLE mcp_audit (
  id         uuid PRIMARY KEY,
  farm_id    uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- No foreign key: the record outlives the client registration.
  client_id  text,
  tool       text NOT NULL,
  outcome    text NOT NULL CHECK (outcome IN ('done', 'refused', 'failed')),
  summary    text NOT NULL DEFAULT '',
  args       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mcp_audit_farm ON mcp_audit (farm_id, created_at DESC);

ALTER TABLE mcp_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY p_mcp_audit_read ON mcp_audit FOR SELECT
  USING (farm_id = current_farm() AND current_role_name() IN ('owner', 'admin'));
CREATE POLICY p_mcp_audit_insert ON mcp_audit FOR INSERT
  WITH CHECK (farm_id = current_farm() AND user_id = current_user_id());

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS mcp_audit;
DROP INDEX IF EXISTS ix_oauth_clients_created;
ALTER TABLE oauth_clients DROP COLUMN IF EXISTS registered_from;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS scope;
-- +goose StatementEnd
