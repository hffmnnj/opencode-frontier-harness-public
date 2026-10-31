import { Plugin } from "@opencode/plugin";
import type { Result as ToolResult, ToolContext } from "@opencode/plugin/promise/tool";
import { fingerprint, SessionStore, type PluginContext } from "./shared";

export const REPORT_TOOL_NAME = "frontier_report";
const MAX_BASELINES_PER_SESSION = 16;
const MAX_OUTSTANDING_CALLS_PER_SESSION = 256;

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
  };
}

function modelKey(providerID: unknown, id: unknown, variant: unknown): string {
  return `${String(providerID)}/${String(id)}/${variant === undefined || variant === null ? "" : String(variant)}`;
}

function isOwnReportTool(name: string): boolean {
  return name === REPORT_TOOL_NAME || name.endsWith(`/${REPORT_TOOL_NAME}`) || name.endsWith(`__${REPORT_TOOL_NAME}`);
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
        name: REPORT_TOOL_NAME,
        description:
          "Report local harness observations for this session (context churn fingerprints, tool/retry/compaction counts, native session counters). Read-only; reports only the calling session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async (_input: unknown, context: ToolContext): Promise<ToolResult> => {
          const sessionID = context.sessionID;
          const state = sessions.get(sessionID);
          let native: { available: boolean; tokens?: NativeTokens; cost?: number } = { available: false };
          try {
            const info = await ctx.session.get({ sessionID });
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
            caveat:
              "Bounded in-memory observation only: no prompts, arguments, outputs, errors, credentials, headers, or file paths retained. State clears on unload/reload; raw native counters are reported without derived ratios.",
          };
          return { content: JSON.stringify(report, null, 2) };
        },
      });
    }),
  ]);

  return async () => {
    sessions.clear();
    await Promise.all(registrations.map((registration) => registration.dispose()));
  };
}

export default Plugin.define({ id: "frontier-insights", setup: setupInsights });
