/**
 * In-memory sliding-window rate limiter for FounderBrain.
 *
 * Single-instance only (one API service / one Worker isolate). That is enough for v1:
 * Railway runs one API replica, and the Worker limit is a burst shield before the origin.
 * Do not pretend this is shared across replicas without a store.
 */
export interface RateLimitConfig {
  /** Max events allowed inside the window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

export type RateLimitResult =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSec: number; readonly remaining: 0 };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly cfg: RateLimitConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): RateLimitResult {
    const now = this.now();
    const stamps = this.prune(key, now);
    if (stamps.length >= this.cfg.limit) {
      const oldest = stamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.cfg.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec, remaining: 0 };
    }
    return { allowed: true, remaining: this.cfg.limit - stamps.length };
  }

  /** Record one successful admission. Call only after check() allowed. */
  hit(key: string): void {
    const now = this.now();
    const stamps = this.prune(key, now);
    stamps.push(now);
    this.hits.set(key, stamps);
  }

  /** Atomic check-and-record used by hooks. */
  take(key: string): RateLimitResult {
    const result = this.check(key);
    if (result.allowed) this.hit(key);
    return result.allowed ? { allowed: true, remaining: result.remaining - 1 } : result;
  }

  private prune(key: string, now: number): number[] {
    const before = now - this.cfg.windowMs;
    const stamps = this.hits.get(key) ?? [];
    while (stamps.length > 0 && (stamps[0] ?? 0) < before) stamps.shift();
    this.hits.set(key, stamps);
    return stamps;
  }
}

/** Defaults tuned for a single staging API: generous for humans, useless for scripts. */
export const API_IP_LIMIT: RateLimitConfig = { limit: 120, windowMs: 60_000 };
export const API_SUBJECT_MUTATION_LIMIT: RateLimitConfig = { limit: 30, windowMs: 60_000 };
/** Edge burst shield for unauthenticated/authenticated /api before origin. */
export const EDGE_IP_LIMIT: RateLimitConfig = { limit: 180, windowMs: 60_000 };

export const MUTATION_PATHS = new Set([
  "PUT /api/brain",
  "PUT /api/orientation",
  "POST /api/restore",
  "POST /api/jobs",
  "POST /api/artifact/:id/accept",
  "DELETE /api/workspace",
  "POST /api/oauth/complete",
  "POST /api/site-import",
  "POST /api/gmail/oauth/start",
  "POST /api/gmail/oauth/complete",
  "DELETE /api/gmail",
  "GET /api/gmail/sent",
  "POST /api/gmail/voice",
  "POST /api/gmail/drafts",
  "PUT /api/gmail/drafts/:id",
  "POST /api/gmail/drafts/:id/save",
  "POST /api/gmail/drafts/:id/send",
  "PUT /api/gmail/settings",
  "POST /api/uploads",
  "DELETE /api/uploads/:id",
]);

export function mutationKey(method: string, path: string): string {
  const bare = path.split("?")[0] ?? path;
  if (method === "POST" && /^\/api\/artifact\/[^/]+\/accept$/.test(bare))
    return "POST /api/artifact/:id/accept";
  if (
    (method === "PUT" || method === "POST") &&
    /^\/api\/gmail\/drafts\/[^/]+(?:\/(?:save|send))?$/.test(bare)
  )
    return method + " " + bare.replace(/(\/api\/gmail\/drafts\/)[^/]+/, "$1:id");
  if (method === "DELETE" && /^\/api\/uploads\/[^/]+$/.test(bare)) return "DELETE /api/uploads/:id";
  return method + " " + bare;
}
