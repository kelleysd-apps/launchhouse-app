/**
 * src/founderbrain/migrate-main.ts
 *
 * WHAT THIS IS. CLI entry for FounderBrain additive migrations and runtime grants.
 * Environment is read only through config.ts helpers.
 */
import { runMigrations } from "../server/db/migrate.ts";
import { closeDb } from "../server/db/client.ts";
import { runFounderBrainMigrations } from "./migrations.ts";
import { migrateJobs } from "./jobs.ts";
import { migrateOpenRouterKeys } from "./openrouter-keys.ts";
import { migrateOrientation } from "./orientation.ts";
import { migrateCrmOauth } from "./crm-oauth.ts";
import { migrateUsage } from "./usage.ts";
import { migrateVoiceSamples } from "./voice-samples.ts";
import { migrateRoutines } from "./routines.ts";
import { migrateGmail } from "./gmail.ts";
import { migrateMedia } from "./media.ts";
import { migrateUploads } from "./uploads.ts";
import { applyMigrationDatabaseUrl, loadMigrationEnv } from "./config.ts";
import postgres from "postgres";

const { adminUrl: admin, runtimeRole: role } = loadMigrationEnv();
applyMigrationDatabaseUrl(admin);
try {
  await runMigrations();
  await runFounderBrainMigrations(admin);
  await migrateJobs(admin);
  await migrateOpenRouterKeys(admin);
  await migrateOrientation(admin);
  await migrateCrmOauth(admin);
  await migrateUsage(admin);
  await migrateVoiceSamples(admin);
  await migrateRoutines(admin);
  await migrateMedia(admin);
  await migrateUploads(admin);
  await migrateGmail(admin);
  if (role) {
    if (!/^fb_[a-z0-9_]{1,50}$/.test(role))
      throw new Error("RUNTIME_DB_ROLE must be a restricted fb_ role name.");
    const sql = postgres(admin, { max: 1, onnotice: () => {} });
    try {
      await sql.begin(async (tx) => {
        const roles = await tx`select rolsuper,rolbypassrls from pg_roles where rolname=${role}`;
        if (!roles[0] || roles[0].rolsuper || roles[0].rolbypassrls)
          throw new Error("Create a NOSUPERUSER NOBYPASSRLS runtime role before granting access.");
        await tx.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        await tx.unsafe(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
        );
        await tx.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
      });
    } finally {
      await sql.end();
    }
    // Generic runtime grants must never restore Gmail access to fb_worker.
    // Reapply the connector's API-only grants after the broad legacy grants.
    await migrateGmail(admin);
  }
  // eslint-disable-next-line no-console -- this is a CLI entry point, not server code
  console.log(
    "FounderBrain additive migrations complete. No data was seeded or copied from a live environment.",
  );
} finally {
  await closeDb();
}
