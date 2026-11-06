/**
 * routstrd-pi — sats display for the pi coding agent.
 *
 * Shows routstrd's real, wallet-signed numbers instead of pi's dollar
 * estimates: what this session spent in satoshis (⚡), which routstr node
 * served the latest response (@host), what is left in the local Cashu
 * wallet (₿), and what is held as API-key credit on remote providers
 * ("Nsats remote").
 *
 * Two display modes, negotiated automatically:
 *
 * 1. Footer mode — when no other extension replaces the footer, this
 *    extension installs a faithful copy of pi's built-in footer whose money
 *    figures are routstrd's: `⚡13.99sats` session spend and `₿1519` wallet
 *    balance where the built-in footer shows its `$` estimate.
 *
 * 2. Status mode — when another footer extension (e.g. Gentle Shell)
 *    replaces this footer, pi disposes our component and we fall back to
 *    `ctx.ui.setStatus()`, which both pi's built-in footer and Gentle
 *    Shell's status bar render: `⚡13.99sats used · ₿1519 wallet`.
 *
 * How session spend is computed
 * ----------------------------
 * Every assistant message routed through a routstr daemon carries the
 * daemon's response id in `message.responseId` (`gen-<ms>-<nonce>` from the
 * OpenAI-shaped routes; `msg_…` from the Anthropic-shaped route, trusted only
 * for messages from the `routstr` provider). The daemon's `GET /usage`
 * endpoint reports the sats actually charged for each response. We collect the session's response ids, look up their
 * `satsCost`, and sum them — so the ⚡ figure is exactly what this session
 * spent, across /resume, /fork and compaction, and never counts requests
 * made by other clients or other pi sessions. Wallet balance comes from
 * `GET /balance` (local Cashu proofs only; remote provider deposits are a
 * future addition).
 *
 * Configuration
 * -------------
 * Optional `~/.routstrd/pi.json` (honoring `ROUTSTRD_DIR`, or
 * `ROUTSTRD_PI_CONFIG`) with `show.spend|usd|node|wallet|remote`, each
 * `true` (always), `false` (never) or `"auto"` (only while it fits the
 * terminal); plus an optional `daemonUrl`. Defaults: spend/wallet always,
 * node/remote auto, usd off. Requires a running routstrd daemon; the base
 * URL resolves from `ROUTSTRD_BASE_URL`, the config's `daemonUrl`, then
 * `~/.routstrd/config.json`, then http://127.0.0.1:8008.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Minimal structural types for the parts of the pi API we use. Kept local so
// the extension is robust against minor type-export differences between pi
// versions; the shapes match dist/core/extensions/types.d.ts.
// ---------------------------------------------------------------------------

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number } | number;
}

interface PiMessage {
  role?: string;
  provider?: string;
  responseId?: string;
  usage?: PiUsage;
  reasoning?: boolean;
}

/** A response id we can attribute sats to: routstr's OpenAI-shaped transports
 * answer with `gen-…` ids; its Anthropic-shaped route passes through `msg_…`
 * ids, which we only trust when the message came from the routstr provider. */
function isDaemonResponseId(rid: unknown, provider: unknown): boolean {
  if (typeof rid !== "string" || !rid) return false;
  if (rid.startsWith("gen-")) return true;
  return provider === "routstr" && rid.startsWith("msg_");
}

interface PiSessionEntry {
  type?: string;
  message?: PiMessage;
  usage?: PiUsage;
}

interface PiModelInfo {
  id?: string;
  provider?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface PiSessionManager {
  getCwd(): string;
  getSessionId(): string;
  getLeafId(): string;
  getEntries(): PiSessionEntry[];
  getSessionName?(): string | undefined;
}

interface PiExtensionContext {
  mode?: string;
  cwd?: string;
  sessionManager?: PiSessionManager;
  model?: PiModelInfo;
  thinkingLevel?: string;
  getContextUsage?: () => PiContextUsage | undefined;
  ui?: {
    setFooter?: (factory: unknown) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

interface PiExtensionApi {
  on(event: string, handler: (event: any, ctx: PiExtensionContext) => void): () => void;
}

interface PiTheme {
  fg(color: "accent" | "success" | "error" | "warning" | "muted" | "dim", text: string): string;
  appearance?: string;
}

interface PiTui {
  /** Ask pi to repaint the TUI (the correct way to refresh after async data lands). */
  requestRender?(force?: boolean): void;
}

interface PiFooterData {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount?(): number;
}

interface PiComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

// ---------------------------------------------------------------------------
// routstrd daemon client
// ---------------------------------------------------------------------------

interface UsageRow {
  requestId?: string;
  upstreamResponseId?: string | null;
  satsCost?: number;
  baseUrl?: string;
  totalUsd?: number;
  cost?: number;
}

const DEFAULT_PORT = 8008;
const STATUS_KEY = "routstrd";

/** Resolve the daemon root URL without a trailing /v1 or slash. */
function resolveDaemonBaseUrl(): string {
  const strip = (url: string): string => url.replace(/\/+$/, "").replace(/\/v1$/, "");
  const fromEnv = process.env.ROUTSTRD_BASE_URL;
  if (fromEnv && fromEnv.trim()) {
    return strip(fromEnv.trim());
  }
  if (rules.daemonUrl) return strip(rules.daemonUrl);
  try {
    const dir = process.env.ROUTSTRD_DIR || path.join(homedir(), ".routstrd");
    const cfg = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf-8"));
    const host = typeof cfg.host === "string" && cfg.host ? cfg.host : "127.0.0.1";
    const port = typeof cfg.port === "number" ? cfg.port : DEFAULT_PORT;
    return `http://${host}:${port}`;
  } catch {
    return `http://127.0.0.1:${DEFAULT_PORT}`;
  }
}

class RoutstrDaemon {
  constructor(private readonly baseUrl: string) {}

  private async get<T>(pathWithQuery: string, timeoutMs = 3000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${pathWithQuery}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Newest-first usage rows. */
  async usage(limit = 500): Promise<UsageRow[]> {
    const data = await this.get<{ output?: unknown[] }>(`/usage?limit=${limit}`);
    const rows = Array.isArray(data?.output) ? data.output : [];
    return rows.filter((r): r is UsageRow => !!r && typeof r === "object");
  }

  /** Sum of local wallet balances across mints, in sats. */
  async walletSats(): Promise<number | null> {
    const data = await this.get<{ output?: { balances?: Record<string, unknown> } }>("/balance");
    const balances = data?.output?.balances;
    if (!balances || typeof balances !== "object") return null;
    let sum = 0;
    let sawNumber = false;
    for (const value of Object.values(balances)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        sum += value;
        sawNumber = true;
      }
    }
    return sawNumber ? sum : null;
  }

  /** Total sats held as API-key credit on remote routstr providers.
   * Slower than the local endpoints: the daemon asks remote nodes live. */
  async remoteKeysSats(timeoutMs = 10_000): Promise<number | null> {
    const data = await this.get<{ output?: { keys?: Array<{ id?: string; balance?: unknown }> } }>(
      "/keys/balance",
      timeoutMs,
    );
    const keys = Array.isArray(data?.output?.keys) ? data.output.keys : [];
    let sum = 0;
    let sawNumber = false;
    for (const key of keys) {
      if (
        typeof key?.id === "string" &&
        key.id.startsWith("apikey:") &&
        typeof key.balance === "number" &&
        Number.isFinite(key.balance)
      ) {
        sum += key.balance;
        sawNumber = true;
      }
    }
    return sawNumber ? sum : null;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (token/cwd formats mirror pi's built-in footer)
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string): string {
  if (!home) return cwd;
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  const rel = path.relative(resolvedHome, resolvedCwd);
  const inside =
    rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${path.sep}${rel}`;
}

function formatSats(sats: number): string {
  if (sats < 100) return sats.toFixed(2);
  if (sats < 1000) return sats.toFixed(1);
  return Math.round(sats).toLocaleString("en-US");
}

function formatUsd(usd: number): string {
  const decimals = usd >= 1 ? 2 : usd >= 0.001 ? 3 : 4;
  return `$${usd.toFixed(decimals)}`;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Session scan (cached like the built-in footer: entries are append-only)
// ---------------------------------------------------------------------------

interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface ScanResult {
  sessionId: string;
  leafId: string;
  entryCount: number;
  /** routstrd response ids of assistant messages, in session order. */
  genIds: string[];
  totals: SessionTotals;
  cacheHitRate?: number;
}

function addUsage(totals: SessionTotals, usage: PiUsage | undefined): void {
  if (!usage) return;
  totals.input += num(usage.input);
  totals.output += num(usage.output);
  totals.cacheRead += num(usage.cacheRead);
  totals.cacheWrite += num(usage.cacheWrite);
  const cost = usage.cost;
  if (typeof cost === "number") totals.cost += cost;
  else if (cost && typeof cost === "object") totals.cost += num(cost.total);
}

function scanSession(ctx: PiExtensionContext): ScanResult | null {
  const sessionManager = ctx.sessionManager;
  if (!sessionManager) return null;

  const entries = sessionManager.getEntries();
  const totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const genIds: string[] = [];
  let cacheHitRate: number | undefined;

  for (const entry of entries) {
    switch (entry?.type) {
      case "usage":
        addUsage(totals, entry.usage);
        break;
      case "message": {
        const message = entry.message;
        if (!message) break;
        if (message.role === "assistant") {
          addUsage(totals, message.usage);
          if (isDaemonResponseId(message.responseId, message.provider)) {
            genIds.push(message.responseId as string);
          }
          const promptTokens =
            num(message.usage?.input) +
            num(message.usage?.cacheRead) +
            num(message.usage?.cacheWrite);
          if (promptTokens > 0) {
            cacheHitRate = (num(message.usage?.cacheRead) / promptTokens) * 100;
          }
        } else if (message.role === "toolResult") {
          addUsage(totals, message.usage);
        }
        break;
      }
      case "branch_summary":
      case "compaction":
        addUsage(totals, entry.usage);
        break;
      default:
        break;
    }
  }

  return {
    sessionId: sessionManager.getSessionId(),
    leafId: sessionManager.getLeafId(),
    entryCount: entries.length,
    genIds,
    totals,
    cacheHitRate,
  };
}

// ---------------------------------------------------------------------------
// Display configuration
//
// All optional, in a small JSON file (default ~/.routstrd/pi.json, honoring
// ROUTSTRD_DIR; ROUTSTRD_PI_CONFIG points elsewhere). Each display rule is
// `true` (always show), `false` (never show) or `"auto"` (show only while
// it fits the terminal). Defaults give the recommended layout; restart pi
// (or /reload) to apply changes.
// ---------------------------------------------------------------------------

/** `true` = always show, `false` = never, `"auto"` = only when it fits. */
type ShowRule = boolean | "auto";

interface DisplayRules {
  daemonUrl?: string;
  show: {
    spend: ShowRule;
    usd: ShowRule;
    node: ShowRule;
    wallet: ShowRule;
    remote: ShowRule;
  };
}

const DEFAULT_SHOW: DisplayRules["show"] = {
  spend: true,
  usd: false,
  node: "auto",
  wallet: true,
  remote: "auto",
};

function displayConfigPath(): string {
  const override = process.env.ROUTSTRD_PI_CONFIG;
  if (override && override.trim()) return override.trim();
  const dir = process.env.ROUTSTRD_DIR || path.join(homedir(), ".routstrd");
  return path.join(dir, "pi.json");
}

function normalizeShowRule(value: unknown, fallback: ShowRule): ShowRule {
  if (value === true || value === false || value === "auto") return value;
  return fallback;
}

function loadDisplayRules(): DisplayRules {
  const fallback: DisplayRules = { show: { ...DEFAULT_SHOW } };
  try {
    const raw = JSON.parse(readFileSync(displayConfigPath(), "utf-8")) as Record<string, unknown>;
    const show = (raw && typeof raw.show === "object" && raw.show) || {};
    return {
      daemonUrl:
        typeof raw.daemonUrl === "string" && raw.daemonUrl.trim()
          ? raw.daemonUrl.trim()
          : undefined,
      show: {
        spend: normalizeShowRule(show.spend, fallback.show.spend),
        usd: normalizeShowRule(show.usd, fallback.show.usd),
        node: normalizeShowRule(show.node, fallback.show.node),
        wallet: normalizeShowRule(show.wallet, fallback.show.wallet),
        remote: normalizeShowRule(show.remote, fallback.show.remote),
      },
    };
  } catch {
    return fallback;
  }
}

const rules = loadDisplayRules();

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const daemon = new RoutstrDaemon(resolveDaemonBaseUrl());

/** gen-id → sats charged, for every response we resolved from /usage. */
const satsByGenId = new Map<string, number>();
/** gen-id → host of the routstr node that served the response. */
const nodeByGenId = new Map<string, string>();
/** gen-id → USD cost reported for the response (informational only). */
const usdByGenId = new Map<string, number>();
/** gen-ids seen in this session that /usage does not know (yet). */
const pendingGenIds = new Set<string>();
/** gen-ids we gave up looking for (avoid endless retries). */
const unresolvedGenIds = new Set<string>();

let walletSats: number | null = null;
let remoteSats: number | null = null;
let daemonReachable: boolean | null = null;
let remoteInFlight = false;
let tuiRef: PiTui | null = null;
let themeRef: PiTheme | null = null;
let footerDataRef: PiFooterData | null = null;
let ctxRef: PiExtensionContext | null = null;
let cachedScan: ScanResult | null = null;

/** True while our own footer component is installed. */
let footerActive = false;
let footerRegistered = false;

let refreshInFlight = false;
let refreshAttempts = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let walletTimer: ReturnType<typeof setInterval> | null = null;

// A /reload re-evaluates the module; make the fresh instance retire the old
// instance's timers so no orphan keeps polling with a stale session context.
const TIMER_SLOT = Symbol.for("routstrd-pi.timers");

function clearTimers(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (walletTimer !== null) {
    clearInterval(walletTimer);
    walletTimer = null;
  }
  const slot = (globalThis as Record<symbol, { removeResizeListener?: () => void } | undefined>)[TIMER_SLOT];
  slot?.removeResizeListener?.();
}

function startTimers(): void {
  const slot = (globalThis as Record<symbol, { clearTimers?: () => void } | undefined>)[TIMER_SLOT];
  slot?.clearTimers?.();
  (globalThis as Record<symbol, unknown>)[TIMER_SLOT] = { clearTimers };
  if (walletTimer === null) {
    walletTimer = setInterval(() => {
      refreshFromDaemon();
      refreshRemote();
    }, 60_000);
  }
  // Status mode has no render callback, so re-fit the status line when the
  // terminal is resized (footer mode gets the new width on its next render).
  const stdout = typeof process === "object" ? (process.stdout as unknown) : undefined;
  if (stdout && typeof (stdout as { on?: unknown }).on === "function") {
    const handler = (): void => {
      if (!footerActive) updateStatus();
    };
    (stdout as { on: (ev: string, fn: () => void) => void }).on("resize", handler);
    (globalThis as Record<symbol, unknown>)[TIMER_SLOT] = {
      clearTimers,
      removeResizeListener: () => {
        (stdout as { off?: (ev: string, fn: () => void) => void }).off?.("resize", handler);
      },
    };
  }
}

function ensureScan(ctx: PiExtensionContext): ScanResult | null {
  const sessionManager = ctx.sessionManager;
  if (!sessionManager) return null;
  const current = scanSession(ctx);
  if (!current) return null;
  if (
    cachedScan &&
    cachedScan.sessionId === current.sessionId &&
    cachedScan.leafId === current.leafId &&
    cachedScan.entryCount === current.entryCount
  ) {
    return cachedScan;
  }
  cachedScan = current;
  return current;
}

function sessionSatsOf(scan: ScanResult): { sats: number; matched: number; usd: number } {
  let sats = 0;
  let matched = 0;
  let usd = 0;
  for (const id of scan.genIds) {
    const value = satsByGenId.get(id);
    if (value !== undefined) {
      sats += value;
      matched += 1;
      usd += usdByGenId.get(id) ?? 0;
    }
  }
  return { sats, matched, usd };
}

/** Hostname of the node that served the most recent matched response. */
function currentNodeOf(scan: ScanResult): string | null {
  for (let i = scan.genIds.length - 1; i >= 0; i -= 1) {
    const node = nodeByGenId.get(scan.genIds[i]);
    if (node) return node;
  }
  return null;
}

function nodeHostOf(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || !baseUrl) return null;
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return baseUrl.replace(/^[a-z]+:\/\//, "").replace(/\/.*/, "") || null;
  }
}

/** Refresh the remote API-key credits independently: the endpoint asks
 * remote nodes live and is slower than the local endpoints, so it must
 * never delay sats attribution. */
async function refreshRemote(): Promise<void> {
  if (remoteInFlight) return;
  remoteInFlight = true;
  try {
    const remote = await daemon.remoteKeysSats();
    if (remote !== null && remote !== remoteSats) {
      remoteSats = remote;
      if (footerActive) tuiRef?.requestRender?.();
      else updateStatus();
    }
  } catch {
    // Older daemons lack /keys/balance, or a remote node is slow: keep the
    // last known figure; nothing to say on the very first failure.
  } finally {
    remoteInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Status mode (used when another extension owns the footer, e.g. Gentle
// Shell, and for the built-in footer's status line)
// ---------------------------------------------------------------------------

function updateStatus(): void {
  if (footerActive || !ctxRef) return;
  const setStatus = ctxRef.ui?.setStatus;
  if (typeof setStatus !== "function") return;
  const scan = ensureScan(ctxRef);
  if (scan) queueLookups(scan);

  // Candidate parts in display order. `true` forces a part on, `false`
  // removes it, and `"auto"` includes it only while the whole line fits the
  // terminal, so a narrow window never shows a figure half-written. (Footer
  // mode applies the same rule with the exact render width.)
  const budget = statusBudget();
  const chosen: string[] = [];
  const add = (part: string | undefined, rule: ShowRule): void => {
    if (!part || rule === false) return;
    if (rule === "auto") {
      const candidate = chosen.length === 0 ? part : `${chosen.join(" · ")} · ${part}`;
      if (candidate.length > budget) return;
    }
    chosen.push(part);
  };

  const routed = !!scan && scan.genIds.length > 0;
  if (routed) {
    const s = scan as ScanResult;
    const { sats, usd } = sessionSatsOf(s);
    if (rules.show.spend !== false) {
      const text =
        daemonReachable === false
          ? "⚡ offline"
          : `⚡${formatSats(sats)}sats used${pendingGenIds.size > 0 ? "…" : ""}`;
      add(text, rules.show.spend);
    }
    if (usd > 0 && rules.show.usd !== false) add(formatUsd(usd), rules.show.usd);
    const host = currentNodeOf(s);
    if (host) add(`@${host}`, rules.show.node);
  }
  if (walletSats !== null && rules.show.wallet !== false) {
    add(`₿${walletSats} wallet`, rules.show.wallet);
  }
  if (remoteSats !== null && rules.show.remote !== false) {
    add(`${remoteSats}sats remote`, rules.show.remote);
  }

  setStatus(STATUS_KEY, chosen.length > 0 ? chosen.join(" · ") : undefined);
}

/** Width budget for the status line: the terminal width minus generous room
 * for the surrounding footer content owned by whoever renders the status. */
function statusBudget(): number {
  const columns =
    typeof process === "object" && process.stdout && typeof process.stdout.columns === "number"
      ? process.stdout.columns
      : 0;
  const width = columns > 0 ? columns : 80;
  return Math.max(36, width - 70);
}

// ---------------------------------------------------------------------------
// Daemon refresh
// ---------------------------------------------------------------------------

/** Look up pending gen-ids and refresh the wallet. Retries with backoff
 * while ids remain unmatched, then gives up (bounded work per batch). */
async function refreshFromDaemon(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  try {
    const wasReachable = daemonReachable;
    dbg(`refresh start: pending=${pendingGenIds.size} attempts=${refreshAttempts}`);
    const [rows, wallet] = await Promise.all([
      daemon.usage(500),
      daemon.walletSats().catch(() => null),
    ]);
    daemonReachable = true;
    dbg(`refresh fetched: rows=${rows.length} pending=${pendingGenIds.size} wallet=${wallet}`);

    const byKey = new Map<string, UsageRow>();
    for (const row of rows) {
      const key = row.upstreamResponseId ?? row.requestId;
      if (typeof key === "string" && typeof row.satsCost === "number") {
        byKey.set(key, row);
      }
    }

    let changed = false;
    for (const id of pendingGenIds) {
      const row = byKey.get(id);
      dbg(`  match ${id}: ${row === undefined ? "MISS" : row.satsCost}`);
      if (row !== undefined) {
        satsByGenId.set(id, row.satsCost as number);
        const host = nodeHostOf(row.baseUrl);
        if (host) nodeByGenId.set(id, host);
        const usd =
          typeof row.totalUsd === "number"
            ? row.totalUsd
            : typeof row.cost === "number"
              ? row.cost
              : undefined;
        if (usd !== undefined) usdByGenId.set(id, usd);
        pendingGenIds.delete(id);
        changed = true;
      }
    }
    // Daemon came back: give up-once ids one more chance.
    if (wasReachable === false && unresolvedGenIds.size > 0) {
      for (const id of unresolvedGenIds) pendingGenIds.add(id);
      unresolvedGenIds.clear();
      refreshAttempts = 0;
    }

    if (wallet !== null && wallet !== walletSats) {
      walletSats = wallet;
      changed = true;
    }

    if (pendingGenIds.size > 0) {
      refreshAttempts += 1;
      // The usage row is written shortly after the response completes; retry
      // a few times, then stop looking for the remainder of this batch.
      if (refreshAttempts <= 4) {
        const delayMs = [500, 1500, 4000, 10000][refreshAttempts - 1] ?? 10000;
        refreshTimer = setTimeout(refreshFromDaemon, delayMs);
      } else {
        for (const id of pendingGenIds) unresolvedGenIds.add(id);
        pendingGenIds.clear();
      }
    } else {
      refreshAttempts = 0;
    }

    if (changed) {
      if (footerActive) tuiRef?.requestRender?.();
      else updateStatus();
    }
  } catch {
    daemonReachable = false;
    if (!footerActive) updateStatus();
    // Retry soon in case the daemon was just starting up, but bound the
    // fast-retry chain; the 60s wallet timer keeps trying after that.
    const wantsData = pendingGenIds.size > 0 || walletSats === null;
    if (wantsData && refreshTimer === null && refreshAttempts < 6) {
      refreshAttempts += 1;
      refreshTimer = setTimeout(refreshFromDaemon, 5000);
    }
  } finally {
    refreshInFlight = false;
  }
}

function scheduleRefresh(): void {
  if (refreshInFlight || refreshTimer !== null) return;
  refreshTimer = setTimeout(refreshFromDaemon, 0);
}

function queueLookups(scan: ScanResult): void {
  let queued = false;
  for (const id of scan.genIds) {
    if (!satsByGenId.has(id) && !pendingGenIds.has(id) && !unresolvedGenIds.has(id)) {
      pendingGenIds.add(id);
      queued = true;
    }
  }
  if (queued || daemonReachable === null) scheduleRefresh();
}

// Temporary debug logging (remove before release).
function dbg(msg: string): void {
  if (process.env.ROUTSTRD_PI_DEBUG !== "1") return;
  try {
    appendFileSync("/tmp/routstrd-pi-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Footer component (footer mode)
// ---------------------------------------------------------------------------

function buildFooterComponent(): PiComponent {
  return {
    render(width: number): string[] {
      const ctx = ctxRef;
      const theme = themeRef;
      const footerData = footerDataRef;
      if (!ctx || !theme) return [""];

      const sessionManager = ctx.sessionManager;
      const scan = ensureScan(ctx);
      if (!scan || !sessionManager) return [""];
      queueLookups(scan);

      const { sats: sessionSats, matched, usd: sessionUsd } = sessionSatsOf(scan);
      const allResolved = matched === scan.genIds.length;

      // --- right side: model name, thinking level (computed early for fitting) ---
      const modelName = ctx.model?.id || "no-model";
      let rightSideWithoutProvider = modelName;
      if (ctx.model?.reasoning) {
        const level = ctx.thinkingLevel || "off";
        rightSideWithoutProvider =
          level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
      }

      // --- token stats (same sources as the built-in footer) ---
      // statParts carry a dropRank: when the line does not fit, "auto"
      // parts drop in rank order (usd first, then remote, then node).
      const totals = scan.totals;
      const statsParts: Array<{ text: string; dropRank?: number }> = [];
      if (totals.input) statsParts.push({ text: theme.fg("dim", `↑${formatTokens(totals.input)}`) });
      if (totals.output) statsParts.push({ text: theme.fg("dim", `↓${formatTokens(totals.output)}`) });
      if (totals.cacheRead) statsParts.push({ text: theme.fg("dim", `R${formatTokens(totals.cacheRead)}`) });
      if (totals.cacheWrite) statsParts.push({ text: theme.fg("dim", `W${formatTokens(totals.cacheWrite)}`) });
      if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && scan.cacheHitRate !== undefined) {
        statsParts.push({ text: theme.fg("dim", `CH${scan.cacheHitRate.toFixed(1)}%`) });
      }

      // --- money: routstrd sats when daemon-routed, else pi's $ estimate ---
      if (scan.genIds.length > 0) {
        if (rules.show.spend !== false) {
          if (daemonReachable === false) {
            statsParts.push({ text: theme.fg("error", "⚡--") });
          } else {
            const syncing = !allResolved ? "…" : "";
            statsParts.push({
              text: theme.fg("accent", `⚡${formatSats(sessionSats)}sats${syncing}`),
            });
          }
        }
        if (sessionUsd > 0 && rules.show.usd !== false) {
          statsParts.push({
            text: theme.fg("dim", formatUsd(sessionUsd)),
            dropRank: rules.show.usd === "auto" ? 1 : undefined,
          });
        }
        const node = currentNodeOf(scan);
        if (node && rules.show.node !== false) {
          statsParts.push({
            text: theme.fg("dim", `@${node}`),
            dropRank: rules.show.node === "auto" ? 3 : undefined,
          });
        }
      } else if (totals.cost > 0) {
        // Not routed through routstrd: keep pi's own dollar estimate visible.
        statsParts.push({ text: theme.fg("dim", `$${totals.cost.toFixed(3)}`) });
      }

      // --- ₿ local wallet balance ---
      if (rules.show.wallet !== false) {
        if (walletSats !== null) {
          statsParts.push({ text: theme.fg("success", `₿${walletSats}`) });
        } else if (daemonReachable === false && scan.genIds.length > 0) {
          // This session is routstrd-routed, so a missing balance is a daemon problem.
          statsParts.push({ text: theme.fg("error", "₿--") });
        }
      }

      // --- API-key credit on remote routstr providers ---
      if (remoteSats !== null && rules.show.remote !== false) {
        statsParts.push({
          text: theme.fg("success", `${remoteSats}sats remote`),
          dropRank: rules.show.remote === "auto" ? 2 : undefined,
        });
      }

      // --- context usage ---
      const contextUsage = ctx.getContextUsage?.();
      const contextWindow = contextUsage?.contextWindow ?? num(ctx.model?.contextWindow);
      const percent = contextUsage?.percent;
      const percentText = percent !== null && percent !== undefined ? percent.toFixed(1) : "?";
      const contextDisplay =
        percent === null || percent === undefined
          ? `?/${formatTokens(contextWindow)}`
          : `${percentText}%/${formatTokens(contextWindow)}`;
      let contextPart: string;
      if (percent !== null && percent !== undefined && percent > 90) {
        contextPart = theme.fg("error", contextDisplay);
      } else if (percent !== null && percent !== undefined && percent > 70) {
        contextPart = theme.fg("warning", contextDisplay);
      } else {
        contextPart = theme.fg("dim", contextDisplay);
      }
      statsParts.push({ text: contextPart });

      // --- drop "auto" extras (usd, then remote, then node) while the line
      // does not fit the terminal; the model truncation below is the last
      // resort and mirrors the built-in footer. ---
      const partsWidth = (parts: typeof statsParts): number =>
        parts.reduce((w, p) => w + visibleWidth(p.text) + 1, -1);
      const fitsWith = (parts: typeof statsParts): boolean =>
        partsWidth(parts) + 2 + visibleWidth(rightSideWithoutProvider) <= width;
      let working = statsParts;
      if (!fitsWith(working)) {
        for (const rank of [1, 2, 3]) {
          if (fitsWith(working)) break;
          const filtered = working.filter((p) => p.dropRank !== rank);
          if (filtered.length !== working.length) working = filtered;
        }
      }
      let statsLeft = working.map((p) => p.text).join(" ");

      // --- right side: provider prefix when there is room ---
      let rightSide = rightSideWithoutProvider;
      const providerCount = footerData?.getAvailableProviderCount?.() ?? 1;
      const statsLeftWidth = visibleWidth(statsLeft);
      if (providerCount > 1 && ctx.model?.provider) {
        const candidate = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
        if (statsLeftWidth + 2 + visibleWidth(candidate) <= width) rightSide = candidate;
      }

      // --- assemble the stats line (right side truncated on narrow widths) ---
      const rightSideWidth = visibleWidth(rightSide);
      let statsLine: string;
      if (statsLeftWidth + 2 + rightSideWidth <= width) {
        statsLine =
          statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - rightSideWidth)) + rightSide;
      } else {
        const availableForRight = width - statsLeftWidth - 2;
        if (availableForRight > 0) {
          const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
          statsLine =
            statsLeft +
            " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) +
            truncatedRight;
        } else {
          statsLine = statsLeft;
        }
      }
      if (visibleWidth(statsLeft) > width) {
        statsLine = truncateToWidth(statsLeft, width, "...");
      }

      // --- line 1: pwd (branch) • session name ---
      let pwd = formatCwdForFooter(sessionManager.getCwd?.() ?? ctx.cwd ?? "", process.env.HOME || "");
      const branch = footerData?.getGitBranch?.();
      if (branch) pwd = `${pwd} (${branch})`;
      const sessionName = sessionManager.getSessionName?.();
      if (sessionName) pwd = `${pwd} • ${sessionName}`;

      const lines = [
        truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
        statsLine,
      ];

      // --- other extensions' status lines (keep pi's contract) ---
      const statuses = footerData?.getExtensionStatuses?.();
      if (statuses && statuses.size > 0) {
        const statusLine = Array.from(statuses.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeStatusText(text))
          .join(" ");
        lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
      }

      return lines;
    },

    invalidate(): void {
      // Re-render is driven by the TUI; state is refreshed asynchronously.
    },

    dispose(): void {
      // Another extension replaced our footer (pi disposes the previous
      // component), or pi is shutting the footer down. Keep the timers: in
      // status mode they still drive wallet/spend updates.
      if (footerActive) {
        footerActive = false;
        updateStatus();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

function latch(ctx: PiExtensionContext): void {
  ctxRef = ctx;
}

function registerFooterOnce(ctx: PiExtensionContext): void {
  if (footerRegistered) return;
  if (ctx.mode !== "tui") return;
  const setFooter = ctx.ui?.setFooter;
  if (typeof setFooter !== "function") return;
  footerRegistered = true;
  setFooter((tui: PiTui, theme: PiTheme, footerData: PiFooterData) => {
    tuiRef = tui;
    themeRef = theme;
    footerDataRef = footerData;
    footerActive = true;
    return buildFooterComponent();
  });
}

export default function routstrdSatsFooter(pi: PiExtensionApi): void {
  pi.on("session_start", (_event, ctx) => {
    latch(ctx);
    startTimers();
    registerFooterOnce(ctx);
    // Restored sessions bring their backlog of response ids; queue them.
    const scan = ensureScan(ctx);
    if (scan) queueLookups(scan);
    scheduleRefresh();
    refreshRemote();
  });
  pi.on("agent_start", (_event, ctx) => {
    latch(ctx);
    registerFooterOnce(ctx);
  });
  pi.on("message_start", (_event, ctx) => {
    latch(ctx);
    registerFooterOnce(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    latch(ctx);
    registerFooterOnce(ctx);
    // Wallet balance drains as the daemon pays; refresh after each response.
    if (event?.message?.role === "assistant") {
      dbg(`message_end assistant: responseId=${event?.message?.responseId} mode=${ctx.mode} footerActive=${footerActive}`);
      // Queue the new response id directly: the assistant entry is not yet in
      // getEntries() at event time, so a scan here would miss it.
      const rid = event?.message?.responseId;
      if (isDaemonResponseId(rid, event?.message?.provider)) {
        const id = rid as string;
        if (!satsByGenId.has(id) && !pendingGenIds.has(id) && !unresolvedGenIds.has(id)) {
          pendingGenIds.add(id);
        }
        refreshAttempts = 0;
      }
      scheduleRefresh();
    }
  });
  pi.on("session_info_changed", (_event, ctx) => latch(ctx));
  pi.on("session_compact", (_event, ctx) => latch(ctx));
  pi.on("session_shutdown", () => clearTimers());
}
