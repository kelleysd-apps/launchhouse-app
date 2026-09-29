/**
 * src/founderbrain-edge/worker.ts
 *
 * FounderBrain's deliberately small edge gateway. It serves the built app from the
 * ASSETS binding and proxies `/api/*` to one fixed Railway origin. It never chooses
 * an upstream from a request.
 *
 * SIGN-IN IS NOT HERE. Hexclave does it: the browser SDK sends the founder to
 * Hexclave's hosted page, they get a one-time code by email, and the SDK holds
 * the resulting session. Every API call from the app carries the access token as
 * `x-stack-access-token`. This Worker forwards that header to the API, which
 * verifies the signature itself. A request to `/api/*` with no token header is
 * refused at the edge, because there is nothing the origin could do with it and
 * the safe answer is no.
 *
 * The only thing this Worker knows about Hexclave is its API origin, and only so
 * the Content-Security-Policy can let the browser SDK talk to it.
 */
import { EDGE_IP_LIMIT, SlidingWindowLimiter } from "../founderbrain/rate-limit.ts";

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}
export interface FounderBrainEdgeEnv {
  ASSETS?: AssetFetcher;
  /** Exact HTTPS origin of the Railway API. Nothing after the host. */
  API_ORIGIN?: string;
  /** Shared with the API. Proves a request came through this Worker. */
  ORIGIN_SECRET?: string;
  /** Hexclave API origin, e.g. `https://api.hexclave.com`. Allowed in `connect-src` and nothing more. */
  HEXCLAVE_API_URL?: string;
  /** Private media bucket origin (R2 S3 endpoint). Browsers upload and play media from it through presigned URLs. */
  MEDIA_ORIGIN?: string;
}
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const API_PREFIX = "/api";
const REQUEST_TIMEOUT_MS = 10_000;
/** The header the web app puts the Hexclave access token in. Same name the API reads. */
export const ACCESS_TOKEN_HEADER = "x-stack-access-token";
/** Request headers that may cross from the browser to the API. Everything else is dropped. */
const FORWARDED_HEADERS = [ACCESS_TOKEN_HEADER, "content-type", "accept", "origin"] as const;
/** Edge-minted correlation id. Never taken from the client (#20). */
const REQUEST_ID_HEADER = "x-request-id";

function validOrigin(value: string | undefined, allowInsecure = false): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const permittedProtocol =
      parsed.protocol === "https:" ||
      (allowInsecure &&
        parsed.protocol === "http:" &&
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"));
    return permittedProtocol &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === "/"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
/**
 * `connect-src` is same-origin plus the Hexclave API origin, because the browser SDK
 * fetches tokens and the user from there. If the variable is missing or malformed the
 * policy stays `'self'` alone: sign-in then fails visibly in the browser rather than
 * the edge quietly widening the policy to whatever string it was given.
 */
function connectSources(env: FounderBrainEdgeEnv): string {
  const hexclave = validOrigin(env.HEXCLAVE_API_URL);
  const media = validOrigin(env.MEDIA_ORIGIN);
  return ["'self'", media?.origin, hexclave?.origin].filter(Boolean).join(" ");
}
/** Video and audio come from the private media bucket through presigned URLs. */
function mediaSources(env: FounderBrainEdgeEnv): string {
  const media = validOrigin(env.MEDIA_ORIGIN);
  return media ? `'self' blob: ${media.origin}` : "'self' blob:";
}
function securityHeaders(headers: Headers, env: FounderBrainEdgeEnv): Headers {
  const result = new Headers(headers);
  result.set("X-Content-Type-Options", "nosniff");
  result.set("X-Frame-Options", "DENY");
  result.set("Referrer-Policy", "no-referrer");
  // Microphone stays allowed: voice dictation is a FounderBrain feature.
  result.set("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  result.set("Cross-Origin-Opener-Policy", "same-origin");
  result.set("Cross-Origin-Resource-Policy", "same-origin");
  result.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob: https:",
      `media-src ${mediaSources(env)}`,
      `connect-src ${connectSources(env)}`,
    ].join("; "),
  );
  return result;
}
function response(body: BodyInit | null, status: number, env: FounderBrainEdgeEnv): Response {
  return new Response(body, {
    status,
    headers: securityHeaders(
      new Headers({ "Content-Type": "application/json", "Cache-Control": "private, no-store" }),
      env,
    ),
  });
}
function isApi(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** Per-isolate burst shield (#19). Not shared across Cloudflare isolates. */
const edgeIpLimiter = new SlidingWindowLimiter(EDGE_IP_LIMIT);

function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf && /^[0-9a-fA-F:.]+$/.test(cf)) return cf;
  return "unknown";
}

function mintRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  // Extremely defensive fallback; Workers and modern Node always have randomUUID.
  return `fb-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
function gatewayHeaders(request: Request, secret: string, requestId: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set("X-FounderBrain-Origin", secret);
  return headers;
}

/** Paths whose upstream can outlast the 10s default. OAuth token exchange is 15s. */
export const SLOW_API_PATHS = new Set([
  "/api/voice",
  "/api/ghl/push",
  "/api/oauth/complete",
  "/api/content/regenerate",
  "/api/higgsfield/connect",
  "/api/higgsfield/estimate",
  "/api/higgsfield/generate",
  "/api/gmail/oauth/complete",
  "/api/gmail/sent",
  "/api/gmail/voice",
  "/api/gmail/drafts",
  "/api/gmail",
  // Up to 10 MB of raw bytes; the 10s default is tight on a slow connection.
  "/api/uploads",
]);
/** Copying a finished Higgsfield file into the bucket can take longer than a plain request. */
export function isSlowApiPath(pathname: string): boolean {
  return (
    SLOW_API_PATHS.has(pathname) ||
    /^\/api\/gmail\/drafts\/[^/]+\/(?:save|send)$/.test(pathname) ||
    /^\/api\/media\/[0-9a-f-]{36}\/refresh$/.test(pathname)
  );
}

export function createFounderBrainWorker(
  fetchImpl: FetchLike = fetch,
  options: { timeoutMs?: number; allowInsecureApiOrigin?: boolean } = {},
) {
  return {
    async fetch(request: Request, env: FounderBrainEdgeEnv): Promise<Response> {
      const inbound = new URL(request.url);
      if (isApi(inbound.pathname)) {
        // Voice transcription waits on Groq; the 10s default would cut it off.
        const timeoutMs = isSlowApiPath(inbound.pathname)
          ? Math.max(
              options.timeoutMs ?? REQUEST_TIMEOUT_MS,
              inbound.pathname.startsWith("/api/gmail/") ? 90_000 : 50_000,
            )
          : (options.timeoutMs ?? REQUEST_TIMEOUT_MS);
        return proxyApi(
          request,
          env,
          fetchImpl,
          inbound,
          timeoutMs,
          options.allowInsecureApiOrigin === true,
        );
      }
      return serveAsset(request, env);
    },
  };
}
async function proxyApi(
  request: Request,
  env: FounderBrainEdgeEnv,
  fetchImpl: FetchLike,
  inbound: URL,
  timeoutMs: number,
  allowInsecureApiOrigin: boolean,
): Promise<Response> {
  const requestId = mintRequestId();
  const limited = edgeIpLimiter.take(`edge:${clientIp(request)}`);
  if (!limited.allowed) {
    const refused = response(
      JSON.stringify({
        error: "rate_limited",
        message: "Too many requests. Wait a moment and try again.",
      }),
      429,
      env,
    );
    refused.headers.set("Retry-After", String(limited.retryAfterSec));
    refused.headers.set(REQUEST_ID_HEADER, requestId);
    return refused;
  }
  const origin = validOrigin(env.API_ORIGIN, allowInsecureApiOrigin);
  if (!origin || !env.ORIGIN_SECRET) {
    const unavailable = response(
      JSON.stringify({
        error: "gateway_unavailable",
        message: "FounderBrain gateway is not configured.",
      }),
      503,
      env,
    );
    unavailable.headers.set(REQUEST_ID_HEADER, requestId);
    return unavailable;
  }
  // `/api/config` is how the browser learns which Hexclave project to sign in to, so it is
  // the one path that must work before there is a token. The API guards it with the origin
  // secret and it contains nothing private.
  if (inbound.pathname !== `${API_PREFIX}/config` && !request.headers.get(ACCESS_TOKEN_HEADER)) {
    const auth = response(
      JSON.stringify({ error: "sign_in_required", message: "Sign in to continue." }),
      401,
      env,
    );
    auth.headers.set(REQUEST_ID_HEADER, requestId);
    return auth;
  }
  const target = new URL(`${inbound.pathname}${inbound.search}`, origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method: request.method,
      headers: gatewayHeaders(request, env.ORIGIN_SECRET, requestId),
      redirect: "manual",
      signal: controller.signal,
    };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    const upstream = await fetchImpl(target, init);
    if (upstream.status >= 300 && upstream.status < 400) {
      const refused = response(
        JSON.stringify({
          error: "upstream_redirect",
          message: "The API returned an unsupported redirect.",
        }),
        502,
        env,
      );
      refused.headers.set(REQUEST_ID_HEADER, requestId);
      return refused;
    }
    const headers = securityHeaders(upstream.headers, env);
    headers.set("Cache-Control", "private, no-store");
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    const timedOut = controller.signal.aborted;
    const message = timedOut ? "FounderBrain API timed out." : "FounderBrain API is unavailable.";
    const failed = response(
      JSON.stringify({ error: timedOut ? "gateway_timeout" : "gateway_unavailable", message }),
      timedOut ? 504 : 502,
      env,
    );
    failed.headers.set(REQUEST_ID_HEADER, requestId);
    return failed;
  } finally {
    clearTimeout(timeout);
  }
}
async function serveAsset(request: Request, env: FounderBrainEdgeEnv): Promise<Response> {
  if (!env.ASSETS)
    return new Response("FounderBrain assets are unavailable.", {
      status: 503,
      headers: securityHeaders(new Headers({ "Content-Type": "text/plain" }), env),
    });
  let asset = await env.ASSETS.fetch(request);
  if (
    asset.status === 404 &&
    (request.method === "GET" || request.method === "HEAD") &&
    request.headers.get("accept")?.includes("text/html")
  ) {
    const index = new URL("/index.html", request.url);
    asset = await env.ASSETS.fetch(
      new Request(index, { method: request.method, headers: request.headers }),
    );
  }
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers: securityHeaders(asset.headers, env),
  });
}

export default createFounderBrainWorker();
