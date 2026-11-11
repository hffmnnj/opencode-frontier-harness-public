import { describe, expect, it } from "bun:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { setupLoopGuard } from "../src/loop-guard";
import type { PluginContext } from "../src/shared";

const AGENT = "build";
const emitted = new WeakMap<Map<string, (event: any) => unknown>, Map<string, string[]>>();

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
  const originalMessage = event.status === "error" ? event.error.message : undefined;
  const result = handler(event);
  if (name === "tool:execute.after") {
    const text = event.status === "error"
      ? event.error.message.slice(originalMessage.length)
      : Array.isArray(event.result.content)
        ? event.result.content.map((part: any) => part.type === "text" ? part.text : "").join("\n")
        : "";
    const notices = text.split(/\n+/).filter((part: string) => part.startsWith("Harness observation:"));
    if (notices.length > 0) {
      const sessions = emitted.get(hooks) ?? new Map<string, string[]>();
      sessions.set(event.sessionID, [...(sessions.get(event.sessionID) ?? []), ...notices]);
      emitted.set(hooks, sessions);
    }
  }
  return result;
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
  const sessions = emitted.get(hooks);
  const notices = sessions?.get(sessionID) ?? [];
  sessions?.delete(sessionID);
  return notices;
}

describe("loop-guard plugin", () => {
  it("loopguard_identicalFailures_nudgesAtThirdAndDeniesAtSeventh", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    expect([...hooks.keys()].sort()).toEqual([
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

  it("loopguard_interleavedIdenticalFailures_stillBlocks", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const failingA = { command: "deploy --check" };
    for (let i = 0; i < 6; i += 1) {
      const a = failedEvents("ses_main", "bash", failingA, "connection refused");
      call(hooks, "tool:execute.before", a.before);
      call(hooks, "tool:execute.after", a.after);
      if (i < 5) {
        const b = failedEvents("ses_main", "bash", { command: `status-${i}` }, `other failure ${i}`);
        call(hooks, "tool:execute.before", b.before);
        call(hooks, "tool:execute.after", b.after);
      }
    }
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", failingA))).toThrow(ToolError);
    expect(() =>
      call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", { command: "status-fresh" })),
    ).not.toThrow();
  });

  it("loopguard_changedResultOrSuccess_clearsFailureHistory", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const input = { command: "deploy --check" };
    failNTimes(hooks, 5, "ses_main", "bash", input, "connection refused");
    expect(guidance(hooks, "ses_main")).toHaveLength(1);
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", input))).not.toThrow();

    const changed = failedEvents("ses_main", "bash", input, "tls handshake timeout");
    call(hooks, "tool:execute.before", changed.before);
    call(hooks, "tool:execute.after", changed.after);
    expect(guidance(hooks, "ses_main")).toEqual([]);

    failNTimes(hooks, 5, "ses_main", "bash", input, "connection refused");
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", input))).not.toThrow();

    const ok = completedEvents("ses_main", "bash", input, "healthy");
    call(hooks, "tool:execute.before", ok.before);
    call(hooks, "tool:execute.after", ok.after);
    failNTimes(hooks, 5, "ses_main", "bash", input, "connection refused");
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", input))).not.toThrow();
  });

  it("loopguard_exactEditNoop_rejectedWithoutRawLeak", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const sentinel = "sk_live_SENTINEL_noop_4X";
    const input = { filePath: `/srv/app/${sentinel}.ts`, oldString: `secret ${sentinel}`, newString: `secret ${sentinel}` };
    let thrown: unknown;
    try {
      call(hooks, "tool:execute.before", beforeEvent("ses_main", "edit", input));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect(String((thrown as Error).message)).toContain("identical");
    expect(String((thrown as Error).message)).not.toContain(sentinel);

    failNTimes(hooks, 2, "ses_main", "bash", { command: "deploy --check" }, "connection refused");
    expect(guidance(hooks, "ses_main")).toEqual([]);
  });

  it("loopguard_similarToolName_notTreatedAsNativeEdit", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const input = { oldString: "same", newString: "same" };
    const events = failedEvents("ses_main", "my-edit", input, "boom");
    expect(() => call(hooks, "tool:execute.before", events.before)).not.toThrow();
    call(hooks, "tool:execute.after", events.after);
    expect(guidance(hooks, "ses_main")).toEqual([]);
  });

  it("loopguard_exactMismatch_advisesRereadOnce", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const input = { filePath: "/srv/app/a.ts", oldString: "aaa", newString: "bbb" };
    const { before, after } = failedEvents("ses_main", "edit", input, "oldString not found in content");
    call(hooks, "tool:execute.before", before);
    call(hooks, "tool:execute.after", after);

    const first = guidance(hooks, "ses_main");
    expect(first.join("\n")).toMatch(/reread/i);
    expect(first.join("\n")).toContain("current hunk");
    expect(first.join("\n")).toContain("no additional permissions");
    expect(first.join("\n")).not.toContain("/srv/app/a.ts");
    const second = guidance(hooks, "ses_main");
    expect(second).toEqual([]);
  });

  it("loopguard_changedMismatch_warnsWithoutDemandingRead", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const input = { filePath: "/srv/app/a.ts", oldString: "aaa", newString: "bbb" };
    const { before, after } = failedEvents(
      "ses_main",
      "edit",
      input,
      "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.",
    );
    call(hooks, "tool:execute.before", before);
    call(hooks, "tool:execute.after", after);

    const texts = guidance(hooks, "ses_main");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("ambiguous or malformed");
    expect(texts[0]).not.toMatch(/reread/i);
  });

  it("loopguard_patchMismatch_advisesCurrentHunk", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const input = { patchText: "*** Begin Patch\n*** End Patch" };
    const { before, after } = failedEvents("ses_main", "patch", input, "Failed to apply update to /srv/app/a.ts: context mismatch");
    call(hooks, "tool:execute.before", before);
    call(hooks, "tool:execute.after", after);
    const texts = guidance(hooks, "ses_main");
    expect(texts.join("\n")).toContain("current hunk");
    expect(texts.join("\n")).not.toContain("/srv/app/a.ts");
  });

  it("loopguard_repeatedNudge_emittedOncePerEpisode", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    failNTimes(hooks, 3, "ses_main");
    expect(guidance(hooks, "ses_main")).toHaveLength(1);
    expect(guidance(hooks, "ses_main")).toEqual([]);
  });

  it("loopguard_advisoryStaysInTriggeringErrorWithoutChangingSystemOrGuard", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const input = { command: "deploy --check" };
    const cause = new Error("underlying failure");
    const metadata = { code: "ECONNREFUSED" };
    const transcript: string[] = [];
    const system = [{ type: "text", text: "stable system prefix" }];

    for (let i = 0; i < 6; i += 1) {
      const { before, after } = failedEvents("ses_main", "bash", input, "connection refused");
      after.error = new ToolError({ message: "connection refused", error: cause, metadata });
      call(hooks, "tool:execute.before", before);
      call(hooks, "tool:execute.after", after);
      expect(after.error).toBeInstanceOf(ToolError);
      expect(after.error.error).toBe(cause);
      expect(after.error.metadata).toEqual(metadata);
      expect(after.error.message.startsWith("connection refused")).toBe(true);
      transcript.push(after.error.message);
      expect(system).toEqual([{ type: "text", text: "stable system prefix" }]);
    }
    expect(hooks.has("session:context")).toBe(false);
    expect(transcript.filter((message) => message.includes("Harness observation:"))).toHaveLength(1);
    expect(transcript[2]).toContain("same failure");
    expect(transcript[3]).toBe("connection refused");
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", input))).toThrow(ToolError);
  });

  it("loopguard_successAdvice_preservesHostContentFallbackAndStructuredResult", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const output = { progress: 42, state: "running" };
    const metadata = { source: "worker" };
    for (let i = 0; i < 4; i += 1) {
      const { before, after } = completedEvents("ses_poll", "job-status", { job: "nightly" }, output);
      after.result = { output, metadata };
      call(hooks, "tool:execute.before", before);
      call(hooks, "tool:execute.after", after);
      expect(after.result.output).toBe(output);
      expect(after.result.metadata).toBe(metadata);
      if (i === 2) {
        expect(after.result.content).toEqual([
          { type: "text", text: '{"progress":42,"state":"running"}' },
          { type: "text", text: expect.stringContaining("Successful calls remain available") },
        ]);
      } else {
        expect(after.result.content).toBeUndefined();
      }
    }
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_poll", "job-status", { job: "nightly" }))).not.toThrow();
  });

  it("loopguard_successAdvice_preservesStringArrayAndEmptyContent", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const variants = [
      { content: "original", expected: [{ type: "text", text: "original" }] },
      { content: [{ type: "file", uri: "file:///image.png", mime: "image/png" }], expected: [{ type: "file", uri: "file:///image.png", mime: "image/png" }] },
      { content: [], expected: [{ type: "text", text: "fallback" }] },
    ];
    for (const [index, variant] of variants.entries()) {
      for (let i = 0; i < 3; i += 1) {
        const { before, after } = completedEvents(`ses_${index}`, "poll", {}, "fallback");
        after.result = { content: variant.content, output: "fallback" };
        call(hooks, "tool:execute.before", before);
        call(hooks, "tool:execute.after", after);
        if (i === 2) expect(after.result.content).toEqual([
          ...variant.expected,
          { type: "text", text: expect.stringContaining("Successful calls remain available") },
        ]);
      }
    }
  });

  it("loopguard_interleavedNudge_emittedOnceAcrossUnrelatedCalls", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const failingA = { command: "deploy --check" };
    for (let i = 0; i < 3; i += 1) {
      const a = failedEvents("ses_main", "bash", failingA, "connection refused");
      call(hooks, "tool:execute.before", a.before);
      call(hooks, "tool:execute.after", a.after);
      if (i < 2) {
        const b = failedEvents("ses_main", "bash", { command: `status-${i}` }, `other failure ${i}`);
        call(hooks, "tool:execute.before", b.before);
        call(hooks, "tool:execute.after", b.after);
      }
    }
    const first = guidance(hooks, "ses_main");
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("same failure");
    expect(guidance(hooks, "ses_main")).toEqual([]);
  });

  it("loopguard_oldFailureExpiresAfterWindowOfOtherObservations", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const target = { command: "deploy --check" };
    failNTimes(hooks, 3, "ses_main", "bash", target, "connection refused");
    expect(guidance(hooks, "ses_main")).toHaveLength(1);

    for (let i = 0; i < 16; i += 1) {
      const probe = completedEvents("ses_main", "read", { file: `file-${i}.txt` }, `content-${i}`);
      call(hooks, "tool:execute.before", probe.before);
      call(hooks, "tool:execute.after", probe.after);
    }
    expect(guidance(hooks, "ses_main")).toEqual([]);
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", target))).not.toThrow();
  });

  it("loopguard_historyBoundedAndCleanupClears", async () => {
    const { ctx, hooks } = makeHarness();
    await setupLoopGuard(ctx);
    const target = { command: "deploy --check" };
    failNTimes(hooks, 6, "ses_main", "bash", target, "connection refused");
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", target))).toThrow(ToolError);

    for (let i = 0; i < 16; i += 1) {
      failNTimes(hooks, 1, "ses_main", "bash", { command: `probe-${i}` }, `failure-${i}`);
    }
    expect(() => call(hooks, "tool:execute.before", beforeEvent("ses_main", "bash", target))).not.toThrow();

    const cleanup = await setupLoopGuard(ctx);
    await cleanup();
  });
});
