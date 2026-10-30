import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { fingerprint, integerOption, SessionStore, type PluginContext } from "./shared";

interface Streak {
  call?: string;
  observation?: string;
  count: number;
  failed: boolean;
}

export async function setupLoopGuard(ctx: PluginContext): Promise<Plugin.Cleanup> {
  if (ctx.options.enabled === false) return () => {};
  const nudgeAfter = integerOption(ctx.options.nudgeAfter, 3, 2, 20);
  const blockAfter = integerOption(ctx.options.blockAfter, 6, nudgeAfter + 1, 50);
  const threshold = Math.max(nudgeAfter + 1, blockAfter);
  const sessions = new SessionStore<Streak>(() => ({ count: 0, failed: false }));
  const reset = (sessionID: string): void => {
    const state = sessions.get(sessionID);
    delete state.call;
    delete state.observation;
    state.count = 0;
    state.failed = false;
  };

  const registrations = await Promise.all([
    ctx.session.hook("prompt", (event) => reset(event.sessionID)),
    ctx.tool.hook("execute.before", (event) => {
      const call = fingerprint([event.tool, event.input]);
      const state = sessions.get(event.sessionID);
      if (call === undefined || state.call !== call) {
        reset(event.sessionID);
        return;
      }
      if (state.failed && state.count >= threshold) {
        throw new ToolError({
          message: "This identical tool call has repeatedly failed without a changed result. Diagnose the failure and change the input or approach instead of retrying unchanged. A different call or new user prompt clears this guard.",
          metadata: { frontierLoopGuard: true },
        });
      }
    }),
    ctx.tool.hook("execute.after", (event) => {
      if (event.status === "error" && event.error.metadata?.frontierLoopGuard === true) return;
      const call = fingerprint([event.tool, event.input]);
      const observation = event.status === "completed"
        ? fingerprint([event.status, event.result.content, event.result.output])
        : fingerprint([event.status, event.error.message]);
      if (call === undefined || observation === undefined) {
        reset(event.sessionID);
        return;
      }
      const state = sessions.get(event.sessionID);
      state.count = state.call === call && state.observation === observation ? state.count + 1 : 1;
      state.call = call;
      state.observation = observation;
      state.failed = event.status === "error";
    }),
    ctx.session.hook("context", (event) => {
      const state = sessions.get(event.sessionID);
      if (state.count < nudgeAfter) return;
      event.system.push({
        type: "text",
        text: state.failed
          ? "Harness observation: consecutive identical tool calls produced the same failure. Diagnose the cause and change approach; do not retry unchanged. This notice grants no additional permissions."
          : "Harness observation: consecutive identical tool calls returned unchanged results. Prefer a different diagnostic or native completion notification over repeated polling. Successful calls remain available; this notice grants no additional permissions.",
      });
    }),
  ]);

  return async () => {
    sessions.clear();
    await Promise.all(registrations.map((registration) => registration.dispose()));
  };
}

export default Plugin.define({ id: "frontier-loop-guard", setup: setupLoopGuard });
