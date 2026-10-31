import { describe, expect, it } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { setupLoopGuard } from "../src/loop-guard";
import type { PluginContext } from "../src/shared";

const AGENT = "build";

function makeHarness(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, (event: any) => unknown>();
  const ctx = {
    options,
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        hooks.set(`session:${name}`, callback);
        return { dispose: async () => {} };
      },
    },
    tool: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        hooks.set(`tool:${name}`, callback);
        return { dispose: async () => {} };
      },
    },
  } as unknown as PluginContext;
  return { ctx, hooks };
}

function call(hooks: Map<string, (event: any) => unknown>, name: string, event: any): unknown {
  const handler = hooks.get(name);
  if (handler === undefined) throw new Error(`hook ${name} was not registered`);
  return handler(event);
}

let callSeq = 0;
function beforeEvent(sessionID: string, tool: string, input: unknown): any {
  return { sessionID, agent: AGENT, messageID: "msg_1", id: `call_${++callSeq}`, tool, input };
}

function failedEvents(sessionID: string, tool: string, input: unknown, message: string): { before: any; after: any } {
  const base = beforeEvent(sessionID, tool, input);
  return { before: base, after: { ...base, status: "error", error: new ToolError({ message }) } };
}

function completedEvents(sessionID: string, tool: string, input: unknown, output: unknown): { before: any; after: any } {
  const base = beforeEvent(sessionID, tool, input);
  return { before: base, after: { ...base, status: "completed", result: { content: `out:${String(output)}`, output } } };
}

function failNTimes(
  hooks: Map<string, (event: any) => unknown>,
  n: number,
  sessionID: string,
  tool = "bash",
  input: unknown = { command: "deploy --check" },
  message = "connection refused",
): void {
  for (let i = 0; i < n; i += 1) {
    const { before, after } = failedEvents(sessionID, tool, input, message);
    call(hooks, "tool:execute.before", before);
    call(hooks, "tool:execute.after", after);
  }
}

function guidance(hooks: Map<string, (event: any) => unknown>, sessionID: string): Array<string> {
  const event: any = { sessionID, system: [] };
  call(hooks, "session:context", event);
  return event.system.map((part: any) => String(part.text));
}

describe("loop-guard plugin", () => {
  it("loopguard_identicalFailures_nudgesAtThirdAndDeniesAtSeventh", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    expect([...hooks.keys()].sort()).toEqual([
      "session:context",
      "session:prompt",
      "tool:execute.after",
      "tool:execute.before",
    ]);

    failNTimes(hooks, 2, "ses_main");
    expect(guidance(hooks, "ses_main")).toEqual([]);

    failNTimes(hooks, 1, "ses_main");
    const nudge = guidance(hooks, "ses_main");
    expect(nudge).toHaveLength(1);
    expect(nudge[0]).toContain("same failure");
    expect(nudge[0]).toContain("no additional permissions");

    failNTimes(hooks, 3, "ses_main");
    let thrown: unknown;
    try {
      call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", { command: "deploy --check" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).metadata?.frontierLoopGuard).toBe(true);
  });

  it("loopguard_pluginDenialEcho_doesNotCountAsFailure", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);

    const echo = beforeEvent("ses_main", "bash", { command: "deploy --check" });
    call(hooks, "tool:execute.after", {
      ...echo,
      status: "error",
      error: new ToolError({ message: "plugin denial", metadata: { frontierLoopGuard: true } }),
    });

    failNTimes(hooks, 2, "ses_main");
    expect(guidance(hooks, "ses_main")).toEqual([]);

    failNTimes(hooks, 1, "ses_main");
    expect(guidance(hooks, "ses_main")).toHaveLength(1);
  });

  it("loopguard_repeatedSuccesses_nudgeWithoutDenialAndChangingPollsStayQuiet", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);

    for (let i = 0; i < 7; i += 1) {
      const { before, after } = completedEvents("ses_poll", "job-status", { job: "nightly" }, "still-running");
      call(hooks, "tool:execute.before", before);
      call(hooks, "tool:execute.after", after);
    }
    const texts = guidance(hooks, "ses_poll");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Successful calls remain available");
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_poll", "job-status", { job: "nightly" }))).not.toThrow();

    for (let i = 0; i < 4; i += 1) {
      const { before, after } = completedEvents("ses_changing", "job-status", { job: "nightly" }, `progress-${i}`);
      call(hooks, "tool:execute.before", before);
      call(hooks, "tool:execute.after", after);
    }
    expect(guidance(hooks, "ses_changing")).toEqual([]);
  });

  it("loopguard_changedInputResultOrPrompt_resetsStreak", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const input = { command: "deploy --check", cwd: "/srv/app" };
    const reordered = { cwd: "/srv/app", command: "deploy --check" };

    failNTimes(hooks, 2, "ses_main", "bash", input, "connection refused");
    failNTimes(hooks, 1, "ses_main", "bash", reordered, "connection refused");
    expect(guidance(hooks, "ses_main")).toHaveLength(1);

    failNTimes(hooks, 1, "ses_main", "bash", input, "tls handshake timeout");
    expect(guidance(hooks, "ses_main")).toEqual([]);

    failNTimes(hooks, 2, "ses_main", "bash", input, "tls handshake timeout");
    expect(guidance(hooks, "ses_main")).toHaveLength(1);

    call(hooks, "session:prompt", { sessionID: "ses_main" });
    expect(guidance(hooks, "ses_main")).toEqual([]);

    failNTimes(hooks, 3, "ses_main", "bash", { command: "deploy --check", cwd: "/other/dir" }, "connection refused");
    expect(guidance(hooks, "ses_main")).toHaveLength(1);
    failNTimes(hooks, 1, "ses_main", "bash", { command: "deploy --force", cwd: "/other/dir" }, "connection refused");
    expect(guidance(hooks, "ses_main")).toEqual([]);
  });

  it("loopguard_sessions_trackedIndependently", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);

    failNTimes(hooks, 6, "ses_a");
    failNTimes(hooks, 2, "ses_b");

    expect(guidance(hooks, "ses_a")).toHaveLength(1);
    expect(guidance(hooks, "ses_b")).toEqual([]);
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_b", "bash", { command: "deploy --check" }))).not.toThrow();
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_a", "bash", { command: "deploy --check" }))).toThrow(ToolError);
  });

  it("loopguard_guidanceWithholdsRawSecrets", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const sentinel = "sk_live_SENTINEL_9zQ7";

    failNTimes(hooks, 3, "ses_main", "bash", { token: sentinel, query: "status" }, `auth failed for ${sentinel}`);
    const texts = guidance(hooks, "ses_main");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("same failure");
    expect(texts.join("\n")).not.toContain(sentinel);
  });

  it("loopguard_disabledPlugin_registersNothing", async () => {
    const { ctx, hooks } = makeHarness({ enabled: false });
    const cleanup = await setupLoopGuard(ctx);
    expect(hooks.size).toBe(0);
    await cleanup();
  });
});
