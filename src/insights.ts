import { Plugin } from "@opencode/plugin";
import type { Result as ToolResult, ToolContext } from "@opencode/plugin/promise/tool";
import { fingerprint, SessionStore, type PluginContext } from "./shared";

export const REPORT_TOOL_NAME = "frontier_report";
export const OUTCOME_TOOL_NAME = "frontier_outcome";
const MAX_BASELINES_PER_SESSION = 16;
const MAX_OUTSTANDING_CALLS_PER_SESSION = 256;
const MAX_OUTCOME_SESSIONS = 128;
const MAX_ANCESTRY_DEPTH = 16;
const MAX_PENDING_LOOKUPS = 16;
const LOOKUP_DEADLINE_MS = 750;

type Outcome = "complete" | "partial" | "blocked";
type Blocker = "authentication" | "environment" | "tooling" | "authorization" | "other";
interface ReportedOutcome {
  outcome: Outcome;
  checks: { passed: number; failed: number; blocked: number; notRun: number };
  blocker?: Blocker;
  artifacts: number;
}
interface OutcomeEntry {
  report: ReportedOutcome;
  ancestors: string[];
}
const BLOCKERS: readonly Blocker[] = ["authentication", "environment", "tooling", "authorization", "other"];

function parseOutcome(input: unknown): ReportedOutcome | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["outcome", "checks", "blocker", "artifacts"].includes(key))) return undefined;
  if (value.outcome !== "complete" && value.outcome !== "partial" && value.outcome !== "blocked") return undefined;
  if (value.checks === null || typeof value.checks !== "object" || Array.isArray(value.checks)) return undefined;
  const checks = value.checks as Record<string, unknown>;
  const keys = ["passed", "failed", "blocked", "notRun"] as const;
  const count = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  if (Object.keys(checks).length !== keys.length || keys.some((key) => !count(checks[key]))) return undefined;
  if (!count(value.artifacts)) return undefined;
  if (value.blocker !== undefined && (typeof value.blocker !== "string" || !BLOCKERS.includes(value.blocker as Blocker))) return undefined;
  if (value.outcome === "complete" && (checks.failed !== 0 || checks.blocked !== 0 || checks.notRun !== 0)) return undefined;
  return {
    outcome: value.outcome,
    checks: { passed: checks.passed as number, failed: checks.failed as number, blocked: checks.blocked as number, notRun: checks.notRun as number },
    ...(value.blocker === undefined ? {} : { blocker: value.blocker as Blocker }),
    artifacts: value.artifacts,
  };
}

function validSessionID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

interface ModelBaseline {
  system?: string;
  tools?: string;
}

interface InsightState {
  contextPreparations: number;
  systemChanges: number;
  toolDefinitionChanges: number;
  currentMessageCount: number;
  currentToolCount: number;
  baselines: Map<string, ModelBaseline>;
  completedTools: number;
  errorTools: number;
  toolMillisTotal: number;
  retryDecisions: number;
  retriesGranted: number;
  compactionPreparations: number;
  outstanding: Map<string, number>;
  advisedBlockers: Set<Blocker>;
}

function createState(): InsightState {
  return {
    contextPreparations: 0,
    systemChanges: 0,
    toolDefinitionChanges: 0,
    currentMessageCount: 0,
    currentToolCount: 0,
    baselines: new Map(),
    completedTools: 0,
    errorTools: 0,
    toolMillisTotal: 0,
    retryDecisions: 0,
    retriesGranted: 0,
    compactionPreparations: 0,
    outstanding: new Map(),
    advisedBlockers: new Set(),
  };
}

function modelKey(providerID: unknown, id: unknown, variant: unknown): string {
  return `${String(providerID)}/${String(id)}/${variant === undefined || variant === null ? "" : String(variant)}`;
}

function isOwnReportTool(name: string): boolean {
  return [REPORT_TOOL_NAME, OUTCOME_TOOL_NAME].some((own) => name === own || name.endsWith(`/${own}`) || name.endsWith(`__${own}`));
}

interface NativeTokens {
  input?: number | undefined;
  output?: number | undefined;
  reasoning?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

function readNativeUsage(info: unknown): { available: boolean; tokens?: NativeTokens; cost?: number } {
  // Installed @opencode/client V2.2.1 types resolve session.get to SessionInfo
  // directly (SessionGetOutput unwraps the transport envelope). Tolerate an
  // envelope shape at runtime without depending on it.
  const envelope = (info as { data?: unknown } | null | undefined)?.data ?? info;
  if (envelope === null || typeof envelope !== "object") return { available: false };
  const record = envelope as Record<string, unknown>;
  const tokens = record["tokens"];
  if (tokens === null || typeof tokens !== "object") return { available: false };
  const numbers = tokens as Record<string, unknown>;
  const pick = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const cache = numbers["cache"];
  const cacheRecord = cache !== null && typeof cache === "object" ? (cache as Record<string, unknown>) : undefined;
  const result: { available: boolean; tokens?: NativeTokens; cost?: number } = {
    available: true,
    tokens: {
      input: pick(numbers["input"]),
      output: pick(numbers["output"]),
      reasoning: pick(numbers["reasoning"]),
      cacheRead: cacheRecord === undefined ? undefined : pick(cacheRecord["read"]),
      cacheWrite: cacheRecord === undefined ? undefined : pick(cacheRecord["write"]),
    },
  };
  const cost = pick(record["cost"]);
  if (cost !== undefined) result.cost = cost;
  return result;
}

export async function setupInsights(ctx: PluginContext): Promise<Plugin.Cleanup> {
  if (ctx.options.enabled === false) return () => {};
  const sessions = new SessionStore<InsightState>(createState);
  const outcomes = new Map<string, OutcomeEntry>();
  const controllers = new Set<AbortController>();
  let pending = 0;
  let active = true;

  // Timed-out native calls keep their slot until they actually settle, so a
  // non-cooperative transport cannot accumulate unbounded background calls.
  async function lookup(sessionID: ToolContext["sessionID"], deadline: number): Promise<unknown> {
    const remaining = deadline - Date.now();
    if (!active || pending >= MAX_PENDING_LOOKUPS || remaining <= 0) return undefined;
    pending += 1;
    const controller = new AbortController();
    controllers.add(controller);
    const request = Promise.resolve()
      .then(() => ctx.session.get({ sessionID }, { signal: controller.signal }))
      .catch(() => undefined)
      .finally(() => { pending -= 1; controllers.delete(controller); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(undefined); }, remaining);
      controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    try { return await Promise.race([request, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async function resolveAncestors(sessionID: ToolContext["sessionID"]): Promise<string[]> {
    const deadline = Date.now() + LOOKUP_DEADLINE_MS;
    const ancestors: string[] = [];
    const seen = new Set<string>();
    let current: string = sessionID;
    for (let depth = 0; depth <= MAX_ANCESTRY_DEPTH; depth += 1) {
      if (!validSessionID(current) || seen.has(current)) return [];
      seen.add(current);
      const info = await lookup(current as ToolContext["sessionID"], deadline);
      const envelope = (info as { data?: unknown } | null | undefined)?.data ?? info;
      if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return [];
      const record = envelope as Record<string, unknown>;
      if (record.id !== current) return [];
      if (record.parentID === undefined) return ancestors;
      if (!validSessionID(record.parentID) || depth === MAX_ANCESTRY_DEPTH) return [];
      ancestors.push(record.parentID);
      current = record.parentID;
    }
    return [];
  }

  function aggregate(sessionID: string) {
    const totals = {
      reports: 0,
      outcomes: { complete: 0, partial: 0, blocked: 0 },
      checks: { passed: 0, failed: 0, blocked: 0, notRun: 0 },
      blockers: { authentication: 0, environment: 0, tooling: 0, authorization: 0, other: 0 },
      artifacts: 0,
    };
    const add = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);
    for (const [id, entry] of outcomes) {
      if (id === sessionID || !entry.ancestors.includes(sessionID)) continue;
      const report = entry.report;
      totals.reports += 1;
      totals.outcomes[report.outcome] += 1;
      for (const key of ["passed", "failed", "blocked", "notRun"] as const) totals.checks[key] = add(totals.checks[key], report.checks[key]);
      if (report.blocker !== undefined) totals.blockers[report.blocker] += 1;
      totals.artifacts = add(totals.artifacts, report.artifacts);
    }
    return totals;
  }

  const registrations = await Promise.all([
    ctx.session.hook("context", (event) => {
      try {
        const state = sessions.get(event.sessionID);
        state.contextPreparations += 1;
        state.currentMessageCount = event.messages.length;
        state.currentToolCount = Object.keys(event.tools).length;
        const key = modelKey(event.model.providerID, event.model.id, event.model.variant);
        const systemHash = fingerprint(event.system);
        const toolsHash = fingerprint(event.tools);
        const blockers = aggregate(event.sessionID).blockers;
        const current = new Set(BLOCKERS.filter((blocker) => blockers[blocker] >= 3));
        const fresh = [...current].filter((blocker) => !state.advisedBlockers.has(blocker));
        state.advisedBlockers = current;
        if (fresh.length > 0) {
          event.system.push({ type: "text", text: `Harness advisory: at least three distinct observed descendants self-report the same blocker category: ${fresh.join(", ")}. Reports are unverified and may be incomplete; diagnose the shared cause. This notice grants no permissions and does not start work.` });
        }
        let baseline = state.baselines.get(key);
        if (baseline === undefined) {
          // First observation for this provider/model/variant establishes a
          // baseline; it is not churn. Stay bounded by skipping new models
          // once full rather than evicting and double-counting later.
          if (state.baselines.size >= MAX_BASELINES_PER_SESSION) return;
          baseline = {};
          state.baselines.set(key, baseline);
        } else {
          if (systemHash !== undefined && baseline.system !== undefined && systemHash !== baseline.system) {
            state.systemChanges += 1;
          }
          if (toolsHash !== undefined && baseline.tools !== undefined && toolsHash !== baseline.tools) {
            state.toolDefinitionChanges += 1;
          }
        }
        if (systemHash !== undefined) baseline.system = systemHash;
        if (toolsHash !== undefined) baseline.tools = toolsHash;
      } catch {
        // Observer errors must never break context preparation.
      }
    }),
    ctx.tool.hook("execute.before", (event) => {
      try {
        if (isOwnReportTool(event.tool)) return;
        const state = sessions.get(event.sessionID);
        if (state.outstanding.size >= MAX_OUTSTANDING_CALLS_PER_SESSION) return;
        state.outstanding.set(event.id, performance.now());
      } catch {
        // Fail open: observation only.
      }
    }),
    ctx.tool.hook("execute.after", (event) => {
      try {
        if (isOwnReportTool(event.tool)) return;
        const state = sessions.get(event.sessionID);
        const started = state.outstanding.get(event.id);
        if (started !== undefined) {
          state.outstanding.delete(event.id);
          const elapsed = performance.now() - started;
          if (Number.isFinite(elapsed) && elapsed >= 0) state.toolMillisTotal += elapsed;
        }
        if (event.status === "completed") state.completedTools += 1;
        else state.errorTools += 1;
      } catch {
        // Fail open: observation only.
      }
    }),
    ctx.session.hook("retry", (event) => {
      try {
        const state = sessions.get(event.sessionID);
        state.retryDecisions += 1;
        if (event.decision.retry === true) state.retriesGranted += 1;
        // The decision itself is never modified.
      } catch {
        // Fail open: observation only.
      }
    }),
    ctx.session.hook("compaction", (event) => {
      try {
        sessions.get(event.sessionID).compactionPreparations += 1;
        // Counted as a preparation only; result/success is not set or inferred.
      } catch {
        // Fail open: observation only.
      }
    }),
    ctx.tool.transform((editor) => {
      editor.add({
        name: OUTCOME_TOOL_NAME,
        description: "Record only the calling session's latest self-reported assignment outcome. This is not independent verification or a native session outcome.",
        input: {
          type: "object", additionalProperties: false,
          required: ["outcome", "checks", "artifacts"],
          properties: {
            outcome: { type: "string", enum: ["complete", "partial", "blocked"] },
            checks: { type: "object", additionalProperties: false, required: ["passed", "failed", "blocked", "notRun"], properties: {
              passed: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, failed: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
              blocked: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, notRun: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            } },
            blocker: { type: "string", enum: [...BLOCKERS] },
            artifacts: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
        options: { codemode: true },
        execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
          const report = parseOutcome(input);
          if (report === undefined) throw new Error("Invalid self-reported outcome or checks.");
          const sessionID = context.sessionID;
          const entry: OutcomeEntry = { report, ancestors: [] };
          outcomes.delete(sessionID);
          if (outcomes.size >= MAX_OUTCOME_SESSIONS) {
            const oldest = outcomes.keys().next().value;
            if (oldest !== undefined) outcomes.delete(oldest);
          }
          outcomes.set(sessionID, entry);
          try {
            const ancestors = await resolveAncestors(sessionID);
            if (active && outcomes.get(sessionID) === entry) entry.ancestors = ancestors;
          } catch { /* Missing ancestry excludes this report from descendants. */ }
          return { content: "Self-reported outcome recorded; not independently verified. Descendant aggregation may be incomplete." };
        },
      });
      editor.add({
        name: REPORT_TOOL_NAME,
        description:
          "Report local harness observations and self-reported outcomes for the calling session and its observed verified descendants. Read-only; self-reports are unverified and may be incomplete.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async (_input: unknown, context: ToolContext): Promise<ToolResult> => {
          const sessionID = context.sessionID;
          const state = sessions.get(sessionID);
          let native: { available: boolean; tokens?: NativeTokens; cost?: number } = { available: false };
          try {
            const info = await lookup(sessionID, Date.now() + LOOKUP_DEADLINE_MS);
            native = readNativeUsage(info);
          } catch {
            native = { available: false };
          }
          const report = {
            sessionID,
            note: "Local harness observations since this plugin instance loaded. Not a benchmark, quality, speed, or cache-hit claim.",
            contextPreparations: state.contextPreparations,
            systemChanges: state.systemChanges,
            toolDefinitionChanges: state.toolDefinitionChanges,
            currentMessageCount: state.currentMessageCount,
            currentToolCount: state.currentToolCount,
            modelBaselineCount: state.baselines.size,
            completedTools: state.completedTools,
            errorTools: state.errorTools,
            toolMillisTotal: Math.round(state.toolMillisTotal * 100) / 100,
            retryDecisions: state.retryDecisions,
            retriesGranted: state.retriesGranted,
            compactionPreparations: state.compactionPreparations,
            nativeUsageAvailable: native.available,
            nativeTokens: native.tokens,
            nativeCost: native.cost,
            reportedOutcome: outcomes.get(sessionID)?.report ?? null,
            descendantSelfReports: aggregate(sessionID),
            caveat:
              "Bounded in-memory observation only: no prompts, arguments, outputs, errors, credentials, headers, or file paths retained. Outcomes and descendant aggregates are self-reported, not independently verified, and incomplete after reload or eviction and when ancestry is missing or invalid. State clears on unload/reload; raw native counters are reported without derived ratios.",
          };
          return { content: JSON.stringify(report, null, 2) };
        },
      });
    }),
  ]);

  return async () => {
    active = false;
    for (const controller of controllers) controller.abort();
    outcomes.clear();
    sessions.clear();
    await Promise.all(registrations.map((registration) => registration.dispose()));
  };
}

export default Plugin.define({ id: "frontier-insights", setup: setupInsights });
