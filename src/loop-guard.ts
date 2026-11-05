import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { fingerprint, integerOption, SessionStore, type PluginContext } from "./shared";

/** Rolling window over all observed tool executions; unrelated calls expire old failures. */
const MAX_RECENT_OBSERVATIONS = 16;

type MismatchKind = "exact" | "changed";
type ToolKind = "edit" | "patch" | "other";

interface RecentEntry {
  call: string;
  observation: string;
  failed: boolean;
}

interface Streak {
  call?: string;
  observation?: string;
  count: number;
  failed: boolean;
  toolKind: ToolKind;
  mismatch: MismatchKind | null;
}

interface GuardState {
  streak: Streak;
  recent: RecentEntry[];
  warnedNudge?: string;
  warnedMismatch?: string;
}

function createState(): GuardState {
  return {
    streak: { count: 0, failed: false, toolKind: "other", mismatch: null },
    recent: [],
  };
}

function resetStreak(state: GuardState): void {
  delete state.streak.call;
  delete state.streak.observation;
  state.streak.count = 0;
  state.streak.failed = false;
  state.streak.toolKind = "other";
  state.streak.mismatch = null;
}

function resetAll(state: GuardState): void {
  resetStreak(state);
  state.recent = [];
  delete state.warnedNudge;
  delete state.warnedMismatch;
}

/** Narrow exact-name match: never substring-match arbitrary tool names. */
function toolKindOf(tool: unknown): ToolKind {
  if (tool === "edit") return "edit";
  if (tool === "patch") return "patch";
  return "other";
}

function readOldNew(input: unknown): { oldString: unknown; newString: unknown } | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (!("oldString" in record) || !("newString" in record)) return null;
  return { oldString: record["oldString"], newString: record["newString"] };
}

/**
 * Classify edit/patch failures without retaining raw text. Exact means the
 * target text or patch chunk did not apply (or the file changed underneath);
 * the other branch covers ambiguous or malformed inputs. Returns null for
 * unrelated tools and unrelated errors.
 */
function classifyMismatch(tool: unknown, message: unknown): MismatchKind | null {
  if (tool !== "edit" && tool !== "patch") return null;
  if (typeof message !== "string") return null;
  const text = message.toLowerCase();
  if (
    text.includes("oldstring not found in content") ||
    text.includes("failed to apply update to") ||
    text.includes("failed to find expected lines") ||
    text.includes("has been modified since") ||
    text.includes("must read the file")
  ) {
    return "exact";
  }
  if (
    text.includes("multiple matches for oldstring") ||
    text.includes("failed to parse patch") ||
    text.includes("no file changes found in patch")
  ) {
    return "changed";
  }
  return null;
}

/**
 * Count failures for one exact call from the rolling window. Only the most
 * recent observation of that call counts: a success or a changed result for
 * the same call stops the count. Unrelated calls are skipped, so interleaved
 * repeats still accumulate until they expire from the window.
 */
function windowFailure(
  recent: RecentEntry[],
  call: string,
): { call: string; observation: string; count: number } | null {
  let latestIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const entry = recent[i];
    if (entry !== undefined && entry.call === call) {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 0) return null;
  const latest = recent[latestIndex];
  if (latest === undefined || !latest.failed) return null;
  const target = latest.observation;
  let count = 0;
  for (let i = latestIndex; i >= 0; i -= 1) {
    const entry = recent[i];
    if (entry === undefined || entry.call !== call) continue;
    if (!entry.failed || entry.observation !== target) break;
    count += 1;
  }
  return { call, observation: target, count };
}

/** Highest-count qualifying failure in the window; ties prefer the most recent. */
function topWindowFailure(
  recent: RecentEntry[],
  nudgeAfter: number,
): { call: string; observation: string; count: number } | null {
  const order: string[] = [];
  const seen = new Set<string>();
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const entry = recent[i];
    if (entry === undefined || seen.has(entry.call)) continue;
    seen.add(entry.call);
    order.push(entry.call);
  }
  let best: { call: string; observation: string; count: number } | null = null;
  for (const call of order) {
    const info = windowFailure(recent, call);
    if (info === null || info.count < nudgeAfter) continue;
    if (best === null || info.count > best.count) best = info;
  }
  return best;
}

function guardError(): ToolError {
  return new ToolError({
    message:
      "This identical tool call has repeatedly failed without a changed result. Diagnose the failure and execute with changed input or a different approach instead of retrying unchanged. A new user prompt, a successful execution, a newly observed result, or expiry from the recent window releases this guard.",
    metadata: { frontierLoopGuard: true },
  });
}

function noopError(): ToolError {
  return new ToolError({
    message:
      "Edit rejected: oldString and newString are identical, so no change would be applied. Provide a different replacement value or use another tool for creation or deletion.",
    metadata: { frontierLoopGuard: true },
  });
}

export async function setupLoopGuard(ctx: PluginContext): Promise<Plugin.Cleanup> {
  if (ctx.options.enabled === false) return () => {};
  const nudgeAfter = integerOption(ctx.options.nudgeAfter, 3, 2, 20);
  const blockAfter = integerOption(ctx.options.blockAfter, 6, nudgeAfter + 1, 50);
  const threshold = Math.max(nudgeAfter + 1, blockAfter);
  const sessions = new SessionStore<GuardState>(createState);

  const registrations = await Promise.all([
    ctx.session.hook("prompt", (event) => {
      resetAll(sessions.get(event.sessionID));
    }),
    ctx.tool.hook("execute.before", (event) => {
      // Exact edit no-ops never reach the native tool. Sanitized: no paths or content.
      if (event.tool === "edit") {
        const pair = readOldNew(event.input);
        if (
          pair !== null &&
          typeof pair.oldString === "string" &&
          typeof pair.newString === "string" &&
          pair.oldString === pair.newString
        ) {
          throw noopError();
        }
      }

      const call = fingerprint([event.tool, event.input]);
      const state = sessions.get(event.sessionID);
      if (call === undefined) {
        resetStreak(state);
        return;
      }
      // Rolling window: an identical failed call/result blocks even when an
      // unrelated tool ran between attempts. Successes never block here.
      const past = windowFailure(state.recent, call);
      if (past !== null && past.count >= threshold) {
        throw guardError();
      }
      // Consecutive streak covers configured thresholds above the window size.
      if (state.streak.failed && state.streak.call === call && state.streak.count >= threshold) {
        throw guardError();
      }
      if (state.streak.call !== call) {
        resetStreak(state);
      }
    }),
    ctx.tool.hook("execute.after", (event) => {
      if (event.status === "error" && event.error.metadata?.frontierLoopGuard === true) return;
      const call = fingerprint([event.tool, event.input]);
      const observation =
        event.status === "completed"
          ? fingerprint([event.status, event.result.content, event.result.output])
          : fingerprint([event.status, event.error.message]);
      if (call === undefined || observation === undefined) {
        resetStreak(sessions.get(event.sessionID));
        return;
      }
      const state = sessions.get(event.sessionID);
      const streak = state.streak;
      const sameEpisode = streak.call === call && streak.observation === observation;
      if (sameEpisode) {
        streak.count += 1;
      } else {
        // A changed call, changed result, or success starts a new streak episode.
        streak.count = 1;
        delete state.warnedMismatch;
      }
      streak.call = call;
      streak.observation = observation;
      streak.failed = event.status === "error";
      streak.toolKind = toolKindOf(event.tool);
      streak.mismatch = event.status === "error" ? classifyMismatch(event.tool, event.error.message) : null;

      // Every observed execution advances the rolling window, so unrelated
      // calls (including successes) expire old failures.
      state.recent.push({ call, observation, failed: event.status === "error" });
      while (state.recent.length > MAX_RECENT_OBSERVATIONS) state.recent.shift();
    }),
    ctx.session.hook("context", (event) => {
      const state = sessions.get(event.sessionID);
      const streak = state.streak;

      // Edit/patch mismatch advice is advisory only. Exact mismatches point at
      // the error's current hunk (or a reread); ambiguous inputs warn without
      // demanding a read, since the current hunk may already have been returned.
      if (
        streak.failed &&
        streak.mismatch !== null &&
        streak.toolKind !== "other" &&
        streak.call !== undefined &&
        streak.observation !== undefined
      ) {
        const key = `${streak.call}:${streak.observation}:${streak.mismatch}`;
        if (state.warnedMismatch !== key) {
          state.warnedMismatch = key;
          event.system.push({
            type: "text",
            text:
              streak.mismatch === "exact"
                ? "Harness observation: the previous edit or patch attempt did not match the current file content. Use the error's current hunk where provided, or reread the focused range (edit) or current hunk (patch) before another attempt; do not retry unchanged. This notice grants no additional permissions."
                : "Harness observation: the previous edit or patch attempt was ambiguous or malformed and did not apply. Review the target and inputs; no change was made. This notice grants no additional permissions.",
          });
        }
      }

      // Repeated-failure nudge covers interleaved repeats from the window and
      // is deduplicated while the same problem episode remains in the window.
      const problem = topWindowFailure(state.recent, nudgeAfter);
      if (problem !== null) {
        const key = `fail:${problem.call}:${problem.observation}`;
        if (state.warnedNudge !== key) {
          state.warnedNudge = key;
          event.system.push({
            type: "text",
            text: "Harness observation: repeated identical tool calls produced the same failure. Diagnose the cause and change approach; do not retry unchanged. This notice grants no additional permissions.",
          });
        }
        return;
      }

      if (
        !streak.failed &&
        streak.call !== undefined &&
        streak.observation !== undefined &&
        streak.count >= nudgeAfter
      ) {
        const key = `ok:${streak.call}:${streak.observation}`;
        if (state.warnedNudge !== key) {
          state.warnedNudge = key;
          event.system.push({
            type: "text",
            text: "Harness observation: consecutive identical tool calls returned unchanged results. Prefer a different diagnostic or native completion notification over repeated polling. Successful calls remain available; this notice grants no additional permissions.",
          });
        }
        return;
      }

      if (problem === null) delete state.warnedNudge;
    }),
  ]);

  return async () => {
    sessions.clear();
    await Promise.all(registrations.map((registration) => registration.dispose()));
  };
}

export default Plugin.define({ id: "frontier-loop-guard", setup: setupLoopGuard });
