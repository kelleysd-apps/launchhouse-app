CREATE TABLE IF NOT EXISTS fb_ai_job (
 id text PRIMARY KEY, founder_id text NOT NULL REFERENCES founder(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL, source_version bigint NOT NULL, source_hash char(64) NOT NULL,
 input_hash char(64) NOT NULL, input_blob_sha char(64) NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed','uncertain')),
 fence integer NOT NULL DEFAULT 0, lease_until timestamptz, error text, provider_request_id text,
 reserved bigint NOT NULL, budget_day date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(founder_id,idempotency_key), UNIQUE(founder_id,id),
 FOREIGN KEY(founder_id,input_blob_sha) REFERENCES ge_blob(founder_id,sha)
);
-- Lifetime key spend already applied for this job (uncertain/partial paths). Reconcile adds only the delta.
ALTER TABLE fb_ai_job ADD COLUMN IF NOT EXISTS openrouter_spend_recorded_microusd bigint NOT NULL DEFAULT 0
  CHECK (openrouter_spend_recorded_microusd >= 0);
-- sha256 over the uploaded documents this job was pinned with (see uploads.ts's
-- allocateDocumentContext). NULL on a job enqueued before uploads existed, treated
-- as the empty-corpus hash by every comparison against it.
ALTER TABLE fb_ai_job ADD COLUMN IF NOT EXISTS uploads_hash text;
CREATE TABLE IF NOT EXISTS fb_job_dispatch (
 job_id text PRIMARY KEY REFERENCES fb_ai_job(id) ON DELETE CASCADE,
 founder_id text NOT NULL REFERENCES founder(id) ON DELETE CASCADE,
 status text NOT NULL, lease_until timestamptz
);
CREATE TABLE IF NOT EXISTS fb_budget (
 scope text NOT NULL, day date NOT NULL, reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0),
 spent bigint NOT NULL DEFAULT 0 CHECK(spent>=0), PRIMARY KEY(scope,day)
);
CREATE TABLE IF NOT EXISTS fb_artifact (
 id text PRIMARY KEY, founder_id text NOT NULL REFERENCES founder(id) ON DELETE CASCADE,
 job_id text NOT NULL, source_version bigint NOT NULL, source_hash char(64) NOT NULL,
 input_hash char(64) NOT NULL, draft_sha char(64) NOT NULL, accepted_sha char(64),
 accept_key text, accept_hash char(64), accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(founder_id,job_id), FOREIGN KEY(founder_id,job_id) REFERENCES fb_ai_job(founder_id,id) ON DELETE CASCADE,
 FOREIGN KEY(founder_id,draft_sha) REFERENCES ge_blob(founder_id,sha)
);
ALTER TABLE fb_artifact ADD COLUMN IF NOT EXISTS uploads_hash text;
ALTER TABLE fb_ai_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_ai_job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_job_tenant ON fb_ai_job;
CREATE POLICY fb_job_tenant ON fb_ai_job USING(founder_id=current_setting('app.founder_id',true)) WITH CHECK(founder_id=current_setting('app.founder_id',true));
ALTER TABLE fb_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_artifact FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_artifact_tenant ON fb_artifact;
CREATE POLICY fb_artifact_tenant ON fb_artifact USING(founder_id=current_setting('app.founder_id',true)) WITH CHECK(founder_id=current_setting('app.founder_id',true));

-- API accesses dispatch rows only inside an authorized workspace transaction.
-- Only the separately provisioned worker role may discover all pending job IDs.
ALTER TABLE fb_job_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_job_dispatch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_dispatch_scope ON fb_job_dispatch;
CREATE POLICY fb_dispatch_scope ON fb_job_dispatch USING(founder_id=current_setting('app.founder_id',true) OR current_user='fb_worker') WITH CHECK(founder_id=current_setting('app.founder_id',true) OR current_user='fb_worker');
ALTER TABLE fb_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_budget FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_budget_scope ON fb_budget;
CREATE POLICY fb_budget_scope ON fb_budget USING(scope='global' OR scope='workspace:'||current_setting('app.founder_id',true)) WITH CHECK(scope='global' OR scope='workspace:'||current_setting('app.founder_id',true));
CREATE TABLE IF NOT EXISTS fb_usage_reconciliation (
 job_id text PRIMARY KEY, scope text NOT NULL, budget_day date NOT NULL,
 reserved bigint NOT NULL, provider_request_id text, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), reconciled_at timestamptz
);
ALTER TABLE fb_usage_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE fb_usage_reconciliation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_reconciliation_scope ON fb_usage_reconciliation;
CREATE POLICY fb_reconciliation_scope ON fb_usage_reconciliation USING(scope='workspace:'||current_setting('app.founder_id',true)) WITH CHECK(scope='workspace:'||current_setting('app.founder_id',true));
