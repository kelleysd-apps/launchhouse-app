-- Encrypted CRM OAuth tokens (HighLevel). Plaintext never reaches the browser.
CREATE TABLE IF NOT EXISTS fb_crm_connection (
  founder_id text PRIMARY KEY REFERENCES founder(id) ON DELETE CASCADE,
  location_id text NOT NULL,
  token_blob_sha char(64) NOT NULL,
  expires_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (founder_id, token_blob_sha) REFERENCES ge_blob(founder_id, sha)
);
ALTER TABLE fb_crm_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_crm_connection FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_crm_connection_tenant ON fb_crm_connection;
CREATE POLICY fb_crm_connection_tenant ON fb_crm_connection
  USING (founder_id = current_setting('app.founder_id', true))
  WITH CHECK (founder_id = current_setting('app.founder_id', true));

-- Stable public connection generation plus one-time OAuth state. This is separate
-- from the token row so disconnect can invalidate callbacks without retaining tokens.
CREATE TABLE IF NOT EXISTS fb_crm_control (
  founder_id text PRIMARY KEY REFERENCES founder(id) ON DELETE CASCADE,
  connection_id text,
  pending_state_hash char(64),
  pending_state_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (connection_id IS NULL OR length(connection_id) BETWEEN 16 AND 80),
  CHECK ((pending_state_hash IS NULL) = (pending_state_expires_at IS NULL))
);
ALTER TABLE fb_crm_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_crm_control FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_crm_control_tenant ON fb_crm_control;
CREATE POLICY fb_crm_control_tenant ON fb_crm_control
  USING (founder_id = current_setting('app.founder_id', true))
  WITH CHECK (founder_id = current_setting('app.founder_id', true));

-- Existing connections receive a stable random migration generation. New
-- generations are cryptographic UUIDs made by the application.
INSERT INTO fb_crm_control (founder_id, connection_id)
SELECT founder_id, 'legacy-' || md5(random()::text || clock_timestamp()::text || founder_id)
FROM fb_crm_connection
ON CONFLICT (founder_id) DO NOTHING;
