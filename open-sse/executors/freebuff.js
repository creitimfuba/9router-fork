import { BaseExecutor } from "./base.js";
import { dbg } from "../utils/debugLog.js";

// FreebuffExecutor — Codebuff's free tier (freebuff.com), ported from the
// reference implementation in OmniRouter (internal/fbridge, Go).
//
// The free lane is OpenAI-compatible on the wire but guarded by three
// bookkeeping calls that must happen before /api/v1/chat/completions:
//
//   1. POST /api/v1/freebuff/session   → per-token free session (instanceId)
//   2. POST /api/v1/agent-runs START   → per-agent run id (rotated 6h)
//   3. codebuff_metadata on the body   → run_id + cost_mode=free + client_id
//
// A FINISH call closes the run after the upstream response is produced.
// 401/403 benches the token for 30 min; session/run invalidation errors are
// retried by rotating the corresponding id (max 4 attempts), mirroring the
// reference implementation.

const DEFAULT_BASE = "https://codebuff.com";
// The UA the official TS SDK sends — required shape upstream, not cosmetic.
const UPSTREAM_UA = "ai-sdk/openai-compatible/1.0.25/codebuff";

const SESSION_REUSE_MARGIN_MS = 5_000;
const RUN_ROTATION_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_ON_AUTH_FAIL_MS = 30 * 60 * 1000;
const MAX_CHAIN_ATTEMPTS = 4;

// Verified free-tier catalog (model wire id → root agent), unmetered first.
export const FREEBUFF_AGENTS = [
  { model: "z-ai/glm-5.3-flash", agent: "base2-free-glm-5-3-flash" },
  { model: "deepseek/deepseek-v4.1-flash", agent: "base2-free-deepseek-v4-1-flash" },
  { model: "mimo/mimo-v2.5", agent: "base2-free-mimo" },
  { model: "upstage/solar-mini4", agent: "base2-free-solar-mini4" },
  { model: "z-ai/glm-5.2", agent: "base2-free-glm" },
  { model: "z-ai/glm-5.3", agent: "base2-free-glm-5-3" },
  { model: "deepseek/deepseek-v4-pro", agent: "base2-free-deepseek" },
  { model: "deepseek/deepseek-v4-flash", agent: "base2-free-deepseek-flash" },
  { model: "deepseek/deepseek-v4.1-pro", agent: "base2-free-deepseek-v4-1-pro" },
  { model: "openai/gpt-5.6-luna", agent: "base2-free-luna" },
  { model: "openai/gpt-6-luna", agent: "base2-free-luna-6" },
  { model: "openai/gpt-5.6-luna-es", agent: "base2-free-luna-es" },
  { model: "crof/kimi-k3-eco", agent: "base2-free-kimi-k3-eco" },
  { model: "stealth/space-bunny-alpha", agent: "base2-free-space-bunny-alpha" },
];

const AGENT_BY_MODEL = new Map(FREEBUFF_AGENTS.map((e) => [e.model, e.agent]));

// Catalog ids also exist in the short form clients tend to type
// ("glm-5.3-flash" instead of "z-ai/glm-5.3-flash").
export function agentForModel(model) {
  const m = String(model || "").trim();
  if (!m) return FREEBUFF_AGENTS[0];
  if (AGENT_BY_MODEL.has(m)) return { model: m, agent: AGENT_BY_MODEL.get(m) };
  const short = FREEBUFF_AGENTS.find((e) => e.model.split("/").pop() === m);
  if (short) return short;
  // Unknown → default unmetered root so the request still completes.
  return FREEBUFF_AGENTS[0];
}

// ---------- per-token state ----------

const pools = new Map(); // token → pool

function poolFor(token) {
  let p = pools.get(token);
  if (!p) {
    p = {
      token,
      session: { status: "", instanceId: "", expiresAt: 0 },
      runs: new Map(), // agentId → { id, startedAt }
      coolTill: 0,
      lastErr: "",
    };
    pools.set(token, p);
  }
  return p;
}

function clip(text, max = 400) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function postJSON(baseUrl, path, token, body, { signal, timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("freebuff timeout")), timeoutMs);
  const merged = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": UPSTREAM_UA,
      },
      body: JSON.stringify(body ?? {}),
      signal: merged,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body — keep raw text */
    }
    return { status: res.status, parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

// Returns a live instance id, or "" when the free-session gate is disabled.
async function ensureSession(pool, baseUrl, signal) {
  const now = Date.now();
  if (
    pool.session.status === "active" &&
    pool.session.instanceId &&
    (pool.session.expiresAt === 0 || now < pool.session.expiresAt - SESSION_REUSE_MARGIN_MS)
  ) {
    return pool.session.instanceId;
  }

  const { status, parsed, text } = await postJSON(baseUrl, "/api/v1/freebuff/session", pool.token, {}, { signal });
  if (status === 404) {
    pool.session = { status: "disabled", instanceId: "", expiresAt: 0 };
    return "";
  }
  if (status === 401 || status === 403) {
    pool.coolTill = Date.now() + COOLDOWN_ON_AUTH_FAIL_MS;
    throw Object.assign(new Error("freebuff auth rejected"), { freebuffAuth: true });
  }
  if (status < 200 || status >= 300) {
    throw new Error(`freebuff session HTTP ${status}: ${clip(text)}`);
  }

  const st = String(parsed?.status || "").trim();
  if (st === "disabled" || st === "") {
    pool.session = { status: "disabled", instanceId: "", expiresAt: 0 };
    return "";
  }
  if (st === "queued") {
    pool.session = { status: "queued", instanceId: "", expiresAt: 0 };
    pool.lastErr = "freebuff waiting room: queued";
    throw Object.assign(new Error("freebuff waiting room: queued"), { freebuffWaitingRoom: true });
  }
  if (st === "active") {
    const expiresAt = parsed?.expiresAt ? Date.parse(parsed.expiresAt) || 0 : 0;
    pool.session = { status: "active", instanceId: String(parsed?.instanceId || ""), expiresAt };
    pool.lastErr = "";
    return pool.session.instanceId;
  }
  throw new Error(`freebuff session status "${st}"`);
}

async function ensureRun(pool, agentId, baseUrl, signal) {
  const live = pool.runs.get(agentId);
  if (live && Date.now() - live.startedAt < RUN_ROTATION_MS) return live.id;

  const { status, parsed, text } = await postJSON(baseUrl, "/api/v1/agent-runs", pool.token, { action: "START", agentId }, { signal });
  if (status === 401 || status === 403) {
    pool.coolTill = Date.now() + COOLDOWN_ON_AUTH_FAIL_MS;
    throw Object.assign(new Error("freebuff auth rejected"), { freebuffAuth: true });
  }
  if (status < 200 || status >= 300) {
    throw new Error(`freebuff start run HTTP ${status}: ${clip(text)}`);
  }
  const runId = String(parsed?.runId || "").trim();
  if (!runId) throw new Error(`freebuff start run: missing runId (${clip(text)})`);
  pool.runs.set(agentId, { id: runId, startedAt: Date.now() });
  return runId;
}

// Best-effort FINISH — bookkeeping only, never blocks the response.
function finishRun(pool, agentId, runId, baseUrl) {
  postJSON(
    baseUrl,
    "/api/v1/agent-runs",
    pool.token,
    { action: "FINISH", runId, status: "completed", totalSteps: 0, directCredits: 0, totalCredits: 0 },
    { timeoutMs: 10_000 }
  ).catch(() => {});
  const cur = pool.runs.get(agentId);
  if (cur && cur.id === runId) pool.runs.delete(agentId);
}

function clientSessionId() {
  return `9router-${(globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 24)}`;
}

// ---------- executor ----------

export class FreebuffExecutor extends BaseExecutor {
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null }) {
    const token = credentials?.accessToken || credentials?.apiKey || "";
    if (!token) {
      throw Object.assign(new Error("freebuff: no token configured (paste a Freebuff token or run `manicode login`)"), {
        status: 401,
      });
    }

    const baseUrl = String(this.config?.baseUrl || DEFAULT_BASE).replace(/\/api\/v1\/chat\/completions$/, "").replace(/\/$/, "");
    const pool = poolFor(token);

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_CHAIN_ATTEMPTS; attempt++) {
      try {
        const picked = agentForModel(model);
        const instanceId = await ensureSession(pool, baseUrl, signal);
        const runId = await ensureRun(pool, picked.agent, baseUrl, signal);

        const meta = { ...(body?.codebuff_metadata || {}) };
        meta.run_id = runId;
        meta.cost_mode = "free";
        meta.client_id = meta.client_id || clientSessionId();
        if (instanceId) meta.freebuff_instance_id = instanceId;

        // Model is normalized to the catalog wire id the root agent serves.
        const outbound = { ...body, model: picked.model, codebuff_metadata: meta };

        const result = await super.execute({
          model: picked.model,
          body: outbound,
          stream,
          credentials,
          signal,
          log,
          proxyOptions,
          providerOverrides,
        });

        finishRun(pool, picked.agent, runId, baseUrl);
        return result;
      } catch (err) {
        lastErr = err;
        if (err?.freebuffAuth) throw err;
        if (signal?.aborted) throw err;
        if (err?.status && err.status >= 400 && err.status < 500) throw err;

        // Session / run invalidation is retryable — rotate and try again.
        const msg = String(err?.message || "");
        if (/session_expired|session_superseded|waiting_room|freebuff_update_required/i.test(msg)) {
          pool.session = { status: "", instanceId: "", expiresAt: 0 };
          dbg("FREEBUFF", `session invalidated, retry ${attempt + 1}/${MAX_CHAIN_ATTEMPTS}`);
          continue;
        }
        if (/run_id|runId|agent-run/i.test(msg)) {
          pool.runs.clear();
          dbg("FREEBUFF", `run invalidated, retry ${attempt + 1}/${MAX_CHAIN_ATTEMPTS}`);
          continue;
        }
        if (err?.freebuffWaitingRoom) throw err;
        throw err;
      }
    }

    throw lastErr || new Error("freebuff: exhausted retries");
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": UPSTREAM_UA,
      ...this.config?.headers,
    };
    const token = credentials?.accessToken || credentials?.apiKey;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    // Free lane only streams on this surface; non-stream requests are accepted
    // but the upstream may still answer in SSE framing.
    headers["Accept"] = stream ? "text/event-stream" : "application/json";
    return headers;
  }
}

export default FreebuffExecutor;
