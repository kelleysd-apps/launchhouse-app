/**
 * src/founderbrain/ghl-push.ts
 *
 * WHAT THIS IS. The Brain -> GoHighLevel push: the founder's Brain fills the
 * pre-built snapshot's custom values (per v3 ghl-values), copy written from
 * their own voice with AI, nothing invented. Founders never build bespoke
 * workflows; the app writes copy into the named snapshot's slots only.
 *
 * Mechanism (from the ops-engine debate): the founder hand-loads the track's
 * snapshot via share link; this module writes location custom values by NAME
 * (create missing, update only empty/PLACEHOLDER, never delete or rename),
 * then proves no slot is blank or placeholder before reporting success.
 */
import { readFile } from "node:fs/promises";

import { DomainError } from "./domain.ts";
import { checkCopy } from "./copy-rules.ts";
import { canonicalize } from "../founderbrain-shared/domain.ts";
import { openRouterProvider } from "./provider.ts";
import { ceilMicro, recordUsageEvent } from "./usage.ts";
import { present, type Brain } from "../founderbrain-shared/domain.ts";
import type { Config } from "./config.ts";
import type { PgBrainStore } from "./store.ts";
import type { GhlPushResult } from "../founderbrain-shared/ghl.ts";
import {
  readConnectionUnlocked,
  statusForConnectionUnlocked,
  withCrmOperationLock,
} from "./crm-oauth.ts";

const GHL_API = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

export type SnapshotName = "B2B" | "B2C" | "Hybrid";

export function snapshotFor(brain: Brain): SnapshotName {
  if (brain.identity.hybrid) return "Hybrid";
  return brain.identity.track === "b2c" ? "B2C" : "B2B";
}

/** The v3 default packs (recommend, never force): a founder can override by pack id. */
export function defaultFirstPack(brain: Brain): string {
  if (brain.identity.track === "b2c")
    return brain.identity.model === "ecommerce" ? "comment_to_dm" : "dm_qualify_book";
  return "lead_follow_up";
}

type ValueEntry = { value: string; key: string; guidance: string };

let valuesCache: Map<string, ValueEntry[]> | null = null;

/** Parse the vendored v3 values.md into section -> [{value name, key, guidance}]. */
export async function loadValueCatalog(force = false): Promise<Map<string, ValueEntry[]>> {
  if (valuesCache && !force) return valuesCache;
  const md = await readFile(
    new URL("../../vendor/growth-engine/plugins/growth-engine/skills/ghl-values/references/values.md", import.meta.url),
    "utf8",
  );
  const sections = new Map<string, ValueEntry[]>();
  let current: string | null = null;
  for (const raw of md.split("\n")) {
    const heading = raw.match(/^##\s+(.+?)\s*(\(\d+\))?$/);
    if (heading) {
      current = (heading[1]?.trim() ?? "").replace(/\s*\(\d+\)$/, "").trim();
      if (current && !sections.has(current)) sections.set(current, []);
      continue;
    }
    const row = raw.match(/^\|\s*(.+?)\s*\|\s*`([a-z0-9_]+)`\s*\|/);
    if (row && current) {
      const bucket = sections.get(current);
      const guidance = raw.split("|")[raw.split("|").length - 2]?.trim() ?? "";
      if (bucket && row[2]) bucket.push({ value: row[1]?.trim() ?? "", key: row[2], guidance });
    }
  }
  if (sections.size === 0) throw new DomainError(503, "voice_not_configured", "Value catalog is missing.");
  valuesCache = sections;
  return sections;
}

/** Verify loop budget (#76): GHL list reads can lag writes; 3 tries x 2s is plenty. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SECTION_BY_PACK: Record<string, string> = {
  lead_follow_up: "B2B Lead follow-up",
  discovery_booking: "B2B Discovery booking",
  proposal_chase: "B2B Proposal chase",
  comment_to_dm: "B2C Comment to DM",
  dm_qualify_book: "B2C DM qualify and book",
  review_request: "B2C Review request",
};

/** Which catalog sections the founder's snapshot needs. Essentials always; the first pack's copy first. */
export function sectionsForPush(brain: Brain, firstPack: string): { gname: string; guidance: string; key: string }[] {
  const catalog = valuesCache;
  if (!catalog) throw new DomainError(503, "voice_not_configured", "Value catalog is missing.");
  const snapshot = snapshotFor(brain);
  const essentials = snapshot === "B2B" ? "B2B Essentials" : "B2C Essentials";
  const packSection = SECTION_BY_PACK[firstPack];
  if (!packSection)
    throw new DomainError(422, "unknown_pack", "That first pack is not in the library. Pick from the six.");
  const wanted = [essentials, packSection].filter(Boolean) as string[];
  const out: { gname: string; guidance: string; key: string }[] = [];
  for (const section of wanted) {
    for (const entry of catalog.get(section) ?? []) {
      out.push({ gname: entry.value, guidance: entry.guidance, key: entry.key });
    }
  }
  if (out.length === 0)
    throw new DomainError(422, "unknown_pack", "That first pack is not in the library. Pick from the six.");
  return out;
}

/** Copy generation: the founder's own voice, no invented numbers or claims. */
async function generateCopy(
  config: Config,
  store: PgBrainStore,
  workspace: string,
  brain: Brain,
  wanted: { gname: string; guidance: string; key: string }[],
  acceptedPack = "",
): Promise<{ copy: Map<string, string>; held: Array<{ name: string; code: string; reason: string }> }> {
  const catalogText = wanted.map((w) => `- ${w.gname} (key: ${w.key}): ${w.guidance}`).join("\n");
  const { loadOpenRouterApiKey, recordOpenRouterSpend } = await import("./openrouter-keys.ts");
  const loaded = await loadOpenRouterApiKey(store, workspace);
  const result = await openRouterProvider(
    {
      model: config.AI_MODEL_RUNNER ?? config.AI_MODEL ?? "anthropic/claude-haiku-4.5",
      max_tokens: 4000,
      system:
        "You write GoHighLevel workflow copy for a founder, using ONLY their Brain. " +
        "For every requested value, write the copy the value's own guidance describes, in the founder's captured voice. " +
        "Return strict JSON: { \"<key>\": \"<copy>\" } for every requested key, nothing else. " +
        "Never invent numbers, results, customer names, prices, or claims that are not in the Brain; where the Brain lacks something the copy needs, keep the copy generic and honest instead of inventing. " +
        "Never promise replies: nothing guarantees or promises that anyone replies, because replies depend on the list, the offer and the timing. " +
        "Never write Instagram DM automation into the copy: no bots, blasts, or automated cold DMs. Automated sending is only for replying to people who wrote first. " +
        "Never write the other track's material: B2C copy never mentions Apollo, ICPs, cold email, DKIM or DMARC; B2B copy never mentions hook banks, DM openers or inbound scripts. " +
        "Never write PLACEHOLDER or merge-field code. Match the track. Respect the voice boundaries.",
      messages: [{
        role: "user",
        content:
          `BRAIN:\n${JSON.stringify(brain)}\n\n` +
          (acceptedPack
            ? `ACCEPTED PACK (use this wording; do not contradict it):\n${acceptedPack}\n\n`
            : "") +
          `REQUESTED VALUES:\n${catalogText}`,
      }],
    },
    loaded.apiKey,
  );
  const inputRate = config.AI_INPUT_USD_PER_MILLION ?? 0;
  const outputRate = config.AI_OUTPUT_USD_PER_MILLION ?? 0;
  const costMicroUsd = ceilMicro(result.inputTokens * inputRate + result.outputTokens * outputRate);
  await recordUsageEvent(store, workspace, config, {
    kind: "ai_tokens",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costMicroUsd,
    meta: { purpose: "ghl_push" },
  });
  if (costMicroUsd > 0) {
    await recordOpenRouterSpend(store, workspace, costMicroUsd, { allowOverLifetime: true });
  }
  const start = result.text.indexOf("{");
  const end = result.text.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new DomainError(422, "copy_failed", "The copy could not be generated. Try again.");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new DomainError(422, "copy_failed", "The copy could not be generated. Try again.");
  }
  const out = new Map<string, string>();
  // Reviewer hardening, ported from the template's rules engine: values that
  // promise replies, automate cold DMs, use the other track's method, or state
  // a number the Brain does not confirm are held out of the push and reported.
  const held: Array<{ name: string; code: string; reason: string }> = [];
  const track = brain.identity.track === "b2c" ? "b2c" : "b2b";
  const brainJson = canonicalize(brain);
  for (const w of wanted) {
    const value = parsed[w.key];
    if (typeof value === "string" && value.trim() && !/PLACEHOLDER/i.test(value)) {
      const trimmed = value.trim().slice(0, 4000);
      const finding = checkCopy(trimmed, { track, brainJson }).find((f) => f.kind === "HOLD");
      if (finding) {
        held.push({ name: w.gname, code: finding.code, reason: finding.reason });
        continue;
      }
      out.set(w.gname, trimmed);
    }
  }
  if (out.size === 0 && held.length === 0)
    throw new DomainError(422, "copy_failed", "The copy could not be generated. Try again.");
  return { copy: out, held };
}

type GhlValue = { id: string; name: string; value?: string };

/** Update requires both fields. A value-only body is refused as "name should not be empty". */
export function ghlCustomValueBody(name: string, value: string): { name: string; value: string } {
  return { name, value };
}

async function ghlFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  // eslint-disable-next-line no-restricted-globals -- CRM egress to the LeadConnector API, same class as crm-oauth's HTTP calls.
  return fetch(`${GHL_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
}

function isUnfilled(value: string | undefined): boolean {
  if (!value || !value.trim()) return true;
  return /PLACEHOLDER/i.test(value) || /\[[^\]]+\]/.test(value) || /\{\{[^}]+\}\}/.test(value);
}

async function ghlRefusal(name: string, response: Response): Promise<string> {
  const body = await response.text();
  let reason = "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    const raw = Array.isArray(parsed.message)
      ? parsed.message.filter((item): item is string => typeof item === "string").join(", ")
      : typeof parsed.message === "string"
        ? parsed.message
        : "";
    if (raw && raw.length < 160 && !/bearer|token|secret|authorization/i.test(raw)) reason = `: ${raw}`;
  } catch {
    reason = "";
  }
  return `GoHighLevel refused "${name}" (${response.status}${reason}). Try again.`;
}

export async function parseCustomValuesList(
  response: Response,
  message: string,
): Promise<GhlValue[]> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new DomainError(422, "ghl_push_failed", message);
  }
  if (!json || typeof json !== "object" || !Array.isArray((json as { customValues?: unknown }).customValues))
    throw new DomainError(422, "ghl_push_failed", message);
  const values: GhlValue[] = [];
  for (const raw of (json as { customValues: unknown[] }).customValues) {
    if (!raw || typeof raw !== "object")
      throw new DomainError(422, "ghl_push_failed", message);
    const item = raw as { id?: unknown; name?: unknown; value?: unknown };
    if (typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name)
      throw new DomainError(422, "ghl_push_failed", message);
    if (Object.prototype.hasOwnProperty.call(item, "value") && typeof item.value !== "string")
      throw new DomainError(422, "ghl_push_failed", message);
    values.push({
      id: item.id,
      name: item.name,
      ...(typeof item.value === "string" ? { value: item.value } : {}),
    });
  }
  return values;
}

export function targetedValues(values: GhlValue[], names: Set<string>): Map<string, GhlValue> {
  const mapped = new Map<string, GhlValue>();
  for (const value of values) {
    if (!names.has(value.name)) continue;
    if (mapped.has(value.name))
      throw new DomainError(409, "ghl_values_ambiguous", `GoHighLevel has more than one "${value.name}" value. Remove the duplicate before continuing.`);
    mapped.set(value.name, value);
  }
  return mapped;
}

/** A missing value is empty only after exact detail identity validation. */
export async function readCustomValue(
  accessToken: string,
  locationId: string,
  entry: GhlValue,
): Promise<{ readable: boolean; text?: string }> {
  const got = await ghlFetch(
    accessToken,
    `/locations/${encodeURIComponent(locationId)}/customValues/${encodeURIComponent(entry.id)}`,
  );
  if (!got.ok) return { readable: false };
  let json: unknown;
  try {
    json = await got.json();
  } catch {
    return { readable: false };
  }
  if (!json || typeof json !== "object") return { readable: false };
  const item = (json as { customValue?: unknown }).customValue;
  if (!item || typeof item !== "object") return { readable: false };
  const detail = item as { id?: unknown; name?: unknown; locationId?: unknown; value?: unknown };
  if (detail.id !== entry.id || detail.name !== entry.name || detail.locationId !== locationId)
    return { readable: false };
  if (!Object.prototype.hasOwnProperty.call(detail, "value")) return { readable: true };
  if (typeof detail.value !== "string") return { readable: false };
  return { readable: true, text: detail.value };
}

export async function pushGhlValues(
  config: Config,
  store: PgBrainStore,
  workspace: string,
  expectedConnectionId: string,
  brain: Brain,
  firstPack: string,
  acceptedPack = "",
): Promise<GhlPushResult> {
  return withCrmOperationLock(store, workspace, async (tx) => {
    // Reject a stale browser generation before provider writes or paid AI.
    const connection = await readConnectionUnlocked(
      store,
      tx,
      workspace,
      config,
      expectedConnectionId,
    );
    if (!connection)
      throw new DomainError(409, "crm_not_connected", "Connect GoHighLevel before pushing copy.");

    const wanted = sectionsForPush(brain, firstPack);
    const linkWanted = wanted.filter((w) => /_link$/.test(w.key));
    const copyWanted = wanted.filter((w) => !/_link$/.test(w.key));

    // Read the location first. This both protects existing values and lets the
    // response report only booking links that are actually still missing.
    const listResponse = await ghlFetch(
      connection.accessToken,
      `/locations/${connection.locationId}/customValues`,
    );
    if (!listResponse.ok)
      throw new DomainError(422, "ghl_push_failed", "GoHighLevel did not answer the values list. Try again.");
    const listed = await parseCustomValuesList(
      listResponse,
      "GoHighLevel returned an unknown values list. Try again.",
    );
    const wantedNames = new Set(wanted.map((value) => value.gname));
    const existing = targetedValues(listed, wantedNames);

    const clinicPaste: string[] = [];
    for (const link of linkWanted) {
      const current = existing.get(link.gname);
      if (!current) {
        clinicPaste.push(link.gname);
        continue;
      }
      const read = await readCustomValue(connection.accessToken, connection.locationId, current);
      if (!read.readable)
        throw new DomainError(422, "ghl_push_failed", `GoHighLevel did not return "${link.gname}". Try again.`);
      if (isUnfilled(read.text)) clinicPaste.push(link.gname);
    }

    // Booking links are founder-provided values. AI sees only copy slots and can
    // never generate, inspect, or fetch a pasted URL.
    const { copy, held } = await generateCopy(
      config,
      store,
      workspace,
      brain,
      copyWanted,
      acceptedPack,
    );

    const pushed: string[] = [];
    const skipped: string[] = [];
    const unread: string[] = [];
    for (const w of copyWanted) {
      const value = copy.get(w.gname);
      if (!value) continue;
      const current = existing.get(w.gname);
      // The founder's own words win: never overwrite a filled value.
      if (current) {
        const read = await readCustomValue(connection.accessToken, connection.locationId, current);
        if (!read.readable) {
          unread.push(w.gname);
          continue;
        }
        if (!isUnfilled(read.text)) {
          skipped.push(w.gname);
          continue;
        }
        const updated = await ghlFetch(
          connection.accessToken,
          `/locations/${connection.locationId}/customValues/${current.id}`,
          { method: "PUT", body: ghlCustomValueBody(w.gname, value) },
        );
        if (!updated.ok)
          throw new DomainError(422, "ghl_push_failed", await ghlRefusal(w.gname, updated));
        pushed.push(w.gname);
      } else {
        const created = await ghlFetch(
          connection.accessToken,
          `/locations/${connection.locationId}/customValues`,
          { method: "POST", body: ghlCustomValueBody(w.gname, value) },
        );
        if (!created.ok)
          throw new DomainError(422, "ghl_push_failed", await ghlRefusal(w.gname, created));
        pushed.push(w.gname);
      }
    }
    if (unread.length > 0)
      throw new DomainError(422, "ghl_push_failed", `GoHighLevel did not return "${unread[0]}". Try again.`);

    const connectionStatus = await statusForConnectionUnlocked(connection);
    if (pushed.length === 0 && skipped.length === copyWanted.length) {
      return {
        connection: connectionStatus,
        snapshot: snapshotFor(brain),
        firstPack,
        pushed,
        skipped,
        proven: true,
        clinicPaste,
        held,
      };
    }

    let proven = false;
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS && !proven; attempt++) {
      if (attempt > 0) await sleep(VERIFY_RETRY_MS);
      const verify = await ghlFetch(
        connection.accessToken,
        `/locations/${connection.locationId}/customValues`,
      );
      if (!verify.ok)
        throw new DomainError(422, "ghl_push_failed", "Could not verify the push. Check GoHighLevel and retry.");
      const verifyValues = await parseCustomValuesList(
        verify,
        "Could not verify the push because GoHighLevel returned an unknown values list.",
      );
      const verifyMap = targetedValues(verifyValues, new Set(copy.keys()));
      proven = true;
      for (const [gname] of copy.entries()) {
        const value = verifyMap.get(gname);
        if (!value) {
          proven = false;
          break;
        }
        const read = await readCustomValue(connection.accessToken, connection.locationId, value);
        if (!read.readable || isUnfilled(read.text)) {
          proven = false;
          break;
        }
      }
    }
    if (!proven) {
      throw new DomainError(
        422,
        "ghl_push_failed",
        pushed.length > 0
          ? "The copy is in GoHighLevel but the read-back check could not confirm it. Open the values list to confirm, or retry."
          : "The push did not stick. Nothing was published. Check the snapshot names match the values list.",
      );
    }
    return {
      connection: connectionStatus,
      snapshot: snapshotFor(brain),
      firstPack,
      pushed,
      skipped,
      proven,
      clinicPaste,
      held,
    };
  });
}

/** Export helper for tests: is this Brain ready to push (all five missions approved)? */
export function brainReadyForPush(brain: Brain): boolean {
  const sections = [brain.identity, brain.customer, brain.offer, brain.voice, brain.context];
  return sections.every((s) => s.approved) && present(brain.context.channelsActive, brain.context.customersNow, brain.context.target90);
}
