-- Founder document uploads. Text documents a founder brings in — a pitch deck, a
-- spreadsheet of leads, a résumé — stored encrypted in Postgres (never R2, unlike
-- media.sql's images and video), sitting alongside the founder's own row. The
-- original bytes and, when the file has one, extracted text each live sealed in
-- ge_blob under the founder's own data key; this table holds metadata and the two
-- sha256 pointers only. RLS-bound to the founder like every founder table.
CREATE TABLE IF NOT EXISTS fb_upload (
  id text PRIMARY KEY,
  founder_id text NOT NULL REFERENCES founder(id) ON DELETE CASCADE,
  name text NOT NULL,
  ext text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  question_key text,
  original_sha char(64) NOT NULL,
  text_sha char(64),
  text_chars integer NOT NULL DEFAULT 0 CHECK (text_chars >= 0),
  readable text NOT NULL CHECK (readable IN ('text', 'no_text')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (founder_id, original_sha) REFERENCES ge_blob(founder_id, sha),
  FOREIGN KEY (founder_id, text_sha) REFERENCES ge_blob(founder_id, sha)
);
CREATE INDEX IF NOT EXISTS fb_upload_founder_idx ON fb_upload(founder_id, created_at DESC);
ALTER TABLE fb_upload ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_upload FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_upload_tenant ON fb_upload;
CREATE POLICY fb_upload_tenant ON fb_upload
  USING (founder_id = current_setting('app.founder_id', true))
  WITH CHECK (founder_id = current_setting('app.founder_id', true));
