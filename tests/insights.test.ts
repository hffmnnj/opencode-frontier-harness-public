import { describe, expect, test } from "bun:test";
import { OUTCOME_TOOL_NAME, REPORT_TOOL_NAME, setupInsights } from "../src/insights";

type Handler = (event: any) => unknown;

interface Fake {
  options: Record<string, unknown>;
  sessionHooks: Map<string, Handler[]>;
  toolHooks: Map<string, Handler[]>;
  addedTool: any;
  tools: Map<string, any>;
  getImpl: (input: { sessionID: string }) => Promise<unknown>;
  ctx: any;
}

function makeFake(getImpl?: Fake["getImpl"]): Fake {
  const sessionHooks = new Map<string, Handler[]>();
  const toolHooks = new Map<string, Handler[]>();
  let addedTool: any;
  const fake: Fake = {
    options: {},
    sessionHooks,
    toolHooks,
    addedTool: undefined,
    tools: new Map(),
    getImpl: getImpl ?? (async () => ({ tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 })),
    ctx: undefined,
  };
  const hookFor = (store: Map<string, Handler[]>) => async (name: string, cb: Handler) => {
    const list = store.get(name) ?? [];
    list.push(cb);
    store.set(name, list);
    return { dispose: async () => {} };
  };
  fake.ctx = {
    options: fake.options,
    session: {
      hook: hookFor(sessionHooks),
      get: (input: { sessionID: string }) => fake.getImpl(input),
    },
    tool: {
      hook: hookFor(toolHooks),
      transform: async (cb: (editor: any) => void) => {
        cb({ add: (tool: any) => { addedTool = tool; fake.addedTool = tool; fake.tools.set(tool.name, tool); } });
        return { dispose: async () => {} };
      },
    },
  };
  return fake;
}

function fire(store: Map<string, Handler[]>, name: string, event: any): void {
  for (const handler of store.get(name) ?? []) void handler(event);
}

async function reportFor(fake: Fake, sessionID: string): Promise<any> {
  const tool = fake.tools.get(REPORT_TOOL_NAME);
  expect(tool.name).toBe(REPORT_TOOL_NAME);
  const result = await tool.execute({}, { sessionID });
  return JSON.parse(typeof result.content === "string" ? result.content : JSON.stringify(result.content));
}

async function outcomeFor(fake: Fake, sessionID: string, input: unknown): Promise<unknown> {
  return fake.tools.get(OUTCOME_TOOL_NAME).execute(input, { sessionID });
}

const checks = (passed: number, failed = 0, blocked = 0, notRun = 0) => ({ passed, failed, blocked, notRun });

function nativeTree(parents: Record<string, string | undefined>): Fake {
  return makeFake(async ({ sessionID }) => {
    if (!(sessionID in parents)) throw new Error("missing");
    return { id: sessionID, ...(parents[sessionID] === undefined ? {} : { parentID: parents[sessionID] }) };
  });
}

function contextEvent(sessionID: string, model: any, system: any, tools: any, messageCount = 3): any {
  return { sessionID, model, system, messages: new Array(messageCount).fill({ role: "user" }), tools, options: {} };
}

// Contract: repeated identical context preparations count no churn; a changed
// section counts once; a new provider/model/variant starts a fresh baseline.
// Fault it rejects: attributing the new model's first observation as churn.
describe("insights context observations", () => {
  test("unchanged_sections_count_no_churn_changed_sections_count_once_per_model", async () => {
    const fake = makeFake();
    const cleanup = await setupInsights(fake.ctx);
    const modelA = { providerID: "anthropic", id: "claude-x", variant: undefined };
    const systemA = [{ type: "text", text: "SECRET-SYSTEM-MARKER" }];
    const toolsA = { read: { description: "d", input: { type: "object" } } };

    fire(fake.sessionHooks, "context", contextEvent("ses-a", modelA, systemA, toolsA));
    fire(fake.sessionHooks, "context", contextEvent("ses-a", modelA, systemA, toolsA));
    let report = await reportFor(fake, "ses-a");
    expect(report.contextPreparations).toBe(2);
    expect(report.systemChanges).toBe(0);
    expect(report.toolDefinitionChanges).toBe(0);
    expect(report.modelBaselineCount).toBe(1);

    fire(fake.sessionHooks, "context", contextEvent("ses-a", modelA, [{ type: "text", text: "changed" }], toolsA, 5));
    report = await reportFor(fake, "ses-a");
    expect(report.systemChanges).toBe(1);
    expect(report.toolDefinitionChanges).toBe(0);
    expect(report.currentMessageCount).toBe(5);
    expect(report.currentToolCount).toBe(1);

    fire(fake.sessionHooks, "context", contextEvent("ses-a", modelA, [{ type: "text", text: "changed" }], { write: { description: "w", input: {} } }));
    report = await reportFor(fake, "ses-a");
    expect(report.systemChanges).toBe(1);
    expect(report.toolDefinitionChanges).toBe(1);

    // Same content under a different model establishes a separate baseline.
    const modelB = { providerID: "openai", id: "gpt-x", variant: "v1" };
    fire(fake.sessionHooks, "context", contextEvent("ses-a", modelB, [{ type: "text", text: "changed" }], { write: { description: "w", input: {} } }));
    report = await reportFor(fake, "ses-a");
    expect(report.systemChanges).toBe(1);
    expect(report.toolDefinitionChanges).toBe(1);
    expect(report.modelBaselineCount).toBe(2);

    await cleanup();
  });
});

// Contract: the report names only the calling session and surfaces native
// lifetime counters verbatim (no derived ratios); lookup failure degrades.
// Fault it rejects: leaking another session's counts or throwing when native
// lookup fails.
describe("insights report scope", () => {
  test("report_names_calling_session_only_and_tolerates_native_lookup_failure", async () => {
    const native: Record<string, unknown> = {
      "ses-a": { tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 2, write: 3 } }, cost: 0.01 },
    };
    const fake = makeFake(async ({ sessionID }) => {
      const info = native[sessionID];
      if (info === undefined) throw new Error("gone");
      return info;
    });
    await setupInsights(fake.ctx);
    fire(fake.sessionHooks, "context", contextEvent("ses-a", { providerID: "p", id: "m" }, [], {}));
    fire(fake.sessionHooks, "context", contextEvent("ses-b", { providerID: "p", id: "m" }, [], {}));
    fire(fake.sessionHooks, "context", contextEvent("ses-b", { providerID: "p", id: "m" }, [], {}));

    const a = await reportFor(fake, "ses-a");
    expect(a.sessionID).toBe("ses-a");
    expect(a.contextPreparations).toBe(1);
    expect(a.nativeUsageAvailable).toBe(true);
    expect(a.nativeTokens).toMatchObject({ input: 10, output: 4, cacheRead: 2, cacheWrite: 3 });
    expect(a.nativeCost).toBe(0.01);
    expect(JSON.stringify(a)).not.toContain("cacheHitRatio");

    const b = await reportFor(fake, "ses-b");
    expect(b.sessionID).toBe("ses-b");
    expect(b.contextPreparations).toBe(2);
    expect(b.nativeUsageAvailable).toBe(false);
  });
});

// Contract: tool/retry/compaction hooks observe without retaining payloads or
// mutating events; the report tool itself is never counted.
// Fault it rejects: counting frontier_report calls or echoing raw inputs.
describe("insights tool retry compaction observations", () => {
  test("counts_outcomes_durations_decisions_preparations_without_raw_retention", async () => {
    const fake = makeFake();
    await setupInsights(fake.ctx);

    fire(fake.toolHooks, "execute.before", { tool: "read", sessionID: "ses-a", id: "call-1", input: { path: "TOP-SECRET-PATH" } });
    fire(fake.toolHooks, "execute.after", { tool: "read", sessionID: "ses-a", id: "call-1", input: {}, status: "completed", result: { content: "TOP-SECRET-OUTPUT" } });
    fire(fake.toolHooks, "execute.before", { tool: "bash", sessionID: "ses-a", id: "call-2", input: {} });
    fire(fake.toolHooks, "execute.after", { tool: "bash", sessionID: "ses-a", id: "call-2", input: {}, status: "error", error: { message: "TOP-SECRET-ERROR" } });
    // Own report tool traffic must not pollute observations.
    fire(fake.toolHooks, "execute.before", { tool: REPORT_TOOL_NAME, sessionID: "ses-a", id: "call-9", input: {} });
    fire(fake.toolHooks, "execute.after", { tool: REPORT_TOOL_NAME, sessionID: "ses-a", id: "call-9", input: {}, status: "completed", result: {} });

    const retryEvent = { sessionID: "ses-a", decision: { retry: true, delay: 100 } };
    fire(fake.sessionHooks, "retry", retryEvent);
    fire(fake.sessionHooks, "retry", { sessionID: "ses-a", decision: { retry: false } });
    expect(retryEvent.decision).toEqual({ retry: true, delay: 100 });

    const compactionEvent: Record<string, unknown> = { sessionID: "ses-a" };
    fire(fake.sessionHooks, "compaction", compactionEvent);
    expect(compactionEvent["result"]).toBeUndefined();

    fire(fake.sessionHooks, "context", contextEvent("ses-a", { providerID: "p", id: "m" }, [{ type: "text", text: "sys" }], {}));

    const report = await reportFor(fake, "ses-a");
    expect(report.completedTools).toBe(1);
    expect(report.errorTools).toBe(1);
    expect(report.toolMillisTotal).toBeGreaterThanOrEqual(0);
    expect(report.retryDecisions).toBe(2);
    expect(report.retriesGranted).toBe(1);
    expect(report.compactionPreparations).toBe(1);
    const serialized = JSON.stringify(report);
    for (const secret of ["TOP-SECRET-PATH", "TOP-SECRET-OUTPUT", "TOP-SECRET-ERROR"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("groups bounded tool observations and error classes without retaining payloads, then clears on reload", async () => {
    const fake = makeFake();
    const cleanup = await setupInsights(fake.ctx);
    const secret = "SENTINEL-PRIVATE-PATH-AND-ERROR";
    const observe = (id: string, tool: string, error?: { message: string; metadata?: object }, before = true) => {
      const event = { id, tool, sessionID: "ses-a", input: { path: secret } };
      if (before) fire(fake.toolHooks, "execute.before", event);
      fire(fake.toolHooks, "execute.after", error === undefined
        ? { ...event, status: "completed", result: { content: secret } }
        : { ...event, status: "error", error });
    };
    observe("1", "read");
    observe("2", "read");
    observe("3", "edit", { message: `Could not find oldString in ${secret}. It must match exactly` });
    observe("4", "edit", { message: "multiple matches for oldString" }, false);
    observe("5", "edit", { message: secret, metadata: { frontierLoopGuard: true } });
    for (let i = 0; i < 40; i += 1) observe(`unknown-${i}`, `${secret}-${i}`, { message: secret });
    observe("own", REPORT_TOOL_NAME);

    const report = await reportFor(fake, "ses-a");
    expect(Object.keys(report.toolObservations).sort()).toEqual(["edit", "other", "read"]);
    expect(report.toolObservations.read).toMatchObject({ completed: 2, timedCalls: 2, errors: { exactMismatch: 0, ambiguousMismatch: 0, loopGuard: 0, other: 0 } });
    expect(report.toolObservations.edit).toMatchObject({ completed: 0, timedCalls: 2, errors: { exactMismatch: 1, ambiguousMismatch: 1, loopGuard: 1, other: 0 } });
    expect(report.toolObservations.other).toMatchObject({ completed: 0, timedCalls: 40, errors: { exactMismatch: 0, ambiguousMismatch: 0, loopGuard: 0, other: 40 } });
    expect(report.toolObservations.read.millisTotal).toBeGreaterThanOrEqual(0);
    expect(report.toolObservations.edit.millisTotal).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.caveat).toContain("not model or queue time");
    expect(report.caveat).toContain("not independently verified");

    await cleanup();
    await setupInsights(fake.ctx);
    const afterReload = await reportFor(fake, "ses-a");
    expect(afterReload.toolObservations).toEqual({});
    expect(afterReload.completedTools).toBe(0);
    expect(afterReload.errorTools).toBe(0);
  });
});

describe("self-reported outcomes", () => {
  test("validates and replaces only the caller's latest report without accepting arbitrary payloads", async () => {
    const fake = nativeTree({ root: undefined });
    await setupInsights(fake.ctx);
    const tool = fake.tools.get(OUTCOME_TOOL_NAME);
    expect(tool.options.codemode).toBe(true);
    expect(tool.input.additionalProperties).toBe(false);
    expect(tool.input.properties.sessionID).toBeUndefined();

    await outcomeFor(fake, "root", { outcome: "complete", checks: checks(4), artifacts: 2 });
    expect((await reportFor(fake, "root")).reportedOutcome).toEqual({ outcome: "complete", checks: checks(4), artifacts: 2 });
    await outcomeFor(fake, "root", { outcome: "partial", checks: checks(2, 1, 0, 1), blocker: "tooling", artifacts: 1 });
    expect((await reportFor(fake, "root")).reportedOutcome).toEqual({ outcome: "partial", checks: checks(2, 1, 0, 1), blocker: "tooling", artifacts: 1 });
    await outcomeFor(fake, "root", { outcome: "blocked", checks: checks(1, 0, 1, 2), blocker: "environment", artifacts: 0 });
    const invalid = [
      { outcome: "complete", checks: checks(0, 1), artifacts: 0 },
      { outcome: "complete", checks: checks(0, 0, 1), artifacts: 0 },
      { outcome: "complete", checks: checks(0, 0, 0, 1), artifacts: 0 },
      { outcome: "partial", checks: checks(-1), artifacts: 0 },
      { outcome: "partial", checks: checks(0.5), artifacts: 0 },
      { outcome: "partial", checks: checks(1), artifacts: Number.MAX_SAFE_INTEGER + 1 },
      { outcome: "partial", checks: { ...checks(1), note: "SENTINEL-CHECK" }, artifacts: 0 },
      { outcome: "blocked", checks: checks(0), blocker: "SENTINEL-BLOCKER", artifacts: 0 },
      { outcome: "partial", checks: checks(1), artifacts: 0, sessionID: "SENTINEL-SELECTOR" },
    ];
    for (const input of invalid) await expect(outcomeFor(fake, "root", input)).rejects.toThrow("Invalid self-reported outcome or checks.");
    const report = await reportFor(fake, "root");
    expect(report.reportedOutcome).toEqual({ outcome: "blocked", checks: checks(1, 0, 1, 2), blocker: "environment", artifacts: 0 });
    expect(JSON.stringify(report)).not.toContain("SENTINEL");
    expect(report.caveat).toContain("self-reported");
    expect(report.caveat).toContain("not independently verified");
  });

  test("includes verified descendants only and excludes siblings, unrelated sessions and malformed ancestry", async () => {
    const parents = { root: undefined, child: "root", grandchild: "child", sibling: "root", outsider: undefined, missing: "gone", cycleA: "cycleB", cycleB: "cycleA" };
    const fake = nativeTree(parents);
    fake.getImpl = async ({ sessionID }) => {
      if (sessionID === "mismatch") return { id: "root", parentID: "root" };
      if (sessionID === "badParent") return { id: sessionID, parentID: { id: "root" } };
      if (!(sessionID in parents)) throw new Error("missing");
      return { id: sessionID, parentID: parents[sessionID as keyof typeof parents] };
    };
    await setupInsights(fake.ctx);
    await outcomeFor(fake, "child", { outcome: "partial", checks: checks(1, 1), artifacts: 2 });
    await outcomeFor(fake, "grandchild", { outcome: "blocked", checks: checks(2, 0, 1), blocker: "tooling", artifacts: 3 });
    for (const id of ["sibling", "outsider", "missing", "cycleA", "mismatch", "badParent"]) {
      await outcomeFor(fake, id, { outcome: "complete", checks: checks(100), artifacts: 100 });
    }
    const child = await reportFor(fake, "child");
    expect(child.reportedOutcome.outcome).toBe("partial");
    expect(child.descendantSelfReports).toEqual({ reports: 1, outcomes: { complete: 0, partial: 0, blocked: 1 }, checks: checks(2, 0, 1), blockers: { authentication: 0, environment: 0, tooling: 1, authorization: 0, other: 0 }, artifacts: 3 });
    const root = await reportFor(fake, "root");
    expect(root.descendantSelfReports.reports).toBe(3);
    expect(root.descendantSelfReports.checks).toEqual(checks(103, 1, 1));
    expect((await reportFor(fake, "outsider")).descendantSelfReports.reports).toBe(0);
    expect(JSON.stringify(child)).not.toContain("grandchild");
    expect(JSON.stringify(child)).not.toContain("sibling");
  });

  test("bounds ancestry depth and outcome retention, and clears reports on cleanup", async () => {
    const fake = makeFake(async ({ sessionID }) => {
      if (sessionID === "root") return { id: sessionID };
      if (sessionID.startsWith("deep")) {
        const index = Number(sessionID.slice(4));
        return { id: sessionID, parentID: index === 17 ? "root" : `deep${index + 1}` };
      }
      return { id: sessionID, parentID: "root" };
    });
    const cleanup = await setupInsights(fake.ctx);
    await outcomeFor(fake, "deep0", { outcome: "blocked", checks: checks(0), blocker: "other", artifacts: 0 });
    expect((await reportFor(fake, "root")).descendantSelfReports.reports).toBe(0);
    for (let i = 0; i < 130; i += 1) await outcomeFor(fake, `child${i}`, { outcome: "complete", checks: checks(1), artifacts: 0 });
    expect((await reportFor(fake, "root")).descendantSelfReports.reports).toBe(128);
    expect((await reportFor(fake, "child0")).reportedOutcome).toBeNull();
    expect((await reportFor(fake, "child129")).reportedOutcome.outcome).toBe("complete");
    await cleanup();
    await setupInsights(fake.ctx);
    expect((await reportFor(fake, "root")).descendantSelfReports.reports).toBe(0);
  });

  test("coalesces repeated blocker advice and re-advises after the threshold clears", async () => {
    const fake = nativeTree({ root: undefined, a: "root", b: "root", c: "root", outsider: undefined });
    await setupInsights(fake.ctx);
    for (const id of ["a", "b", "c", "outsider"]) await outcomeFor(fake, id, { outcome: "blocked", checks: checks(0, 0, 1), blocker: "authentication", artifacts: 0 });
    const first = contextEvent("root", { providerID: "p", id: "m" }, [], {});
    fire(fake.sessionHooks, "context", first);
    expect(first.system).toHaveLength(1);
    expect(first.system[0].text).toContain("authentication");
    expect(first.system[0].text).toContain("self-report");
    expect(first.system[0].text).toContain("no permissions");
    const second = contextEvent("root", { providerID: "p", id: "m" }, [], {});
    fire(fake.sessionHooks, "context", second);
    expect(second.system).toHaveLength(0);
    const sibling = contextEvent("a", { providerID: "p", id: "m" }, [], {});
    fire(fake.sessionHooks, "context", sibling);
    expect(sibling.system).toHaveLength(0);
    await outcomeFor(fake, "c", { outcome: "complete", checks: checks(1), artifacts: 0 });
    const below = contextEvent("root", { providerID: "p", id: "m" }, [], {});
    fire(fake.sessionHooks, "context", below);
    expect(below.system).toHaveLength(0);
    await outcomeFor(fake, "c", { outcome: "blocked", checks: checks(0), blocker: "authentication", artifacts: 0 });
    const again = contextEvent("root", { providerID: "p", id: "m" }, [], {});
    fire(fake.sessionHooks, "context", again);
    expect(again.system).toHaveLength(1);
  });

  test("limits pending native lookups and cleanup releases callers even when the transport never settles", async () => {
    let nativeCalls = 0;
    const fake = makeFake(async () => { nativeCalls += 1; return new Promise(() => {}); });
    const cleanup = await setupInsights(fake.ctx);
    const requests = Array.from({ length: 20 }, (_, i) => outcomeFor(fake, `child${i}`, { outcome: "partial", checks: checks(0), artifacts: 0 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(nativeCalls).toBe(16);
    await cleanup();
    await Promise.all(requests);
    expect(nativeCalls).toBe(16);
  });

  test("a late ancestry lookup cannot overwrite a newer self-report", async () => {
    let finishFirst!: (value: unknown) => void;
    let first = true;
    const fake = makeFake(async ({ sessionID }) => {
      if (sessionID === "child" && first) {
        first = false;
        return new Promise((resolve) => { finishFirst = resolve; });
      }
      return sessionID === "root" ? { id: "root" } : { id: sessionID, parentID: "root" };
    });
    await setupInsights(fake.ctx);
    const older = outcomeFor(fake, "child", { outcome: "blocked", checks: checks(0), blocker: "environment", artifacts: 0 });
    await Promise.resolve();
    await outcomeFor(fake, "child", { outcome: "complete", checks: checks(3), artifacts: 1 });
    finishFirst({ id: "child", parentID: "root" });
    await older;
    expect((await reportFor(fake, "child")).reportedOutcome).toEqual({ outcome: "complete", checks: checks(3), artifacts: 1 });
    const root = await reportFor(fake, "root");
    expect(root.descendantSelfReports.outcomes).toEqual({ complete: 1, partial: 0, blocked: 0 });
    expect(root.descendantSelfReports.blockers.environment).toBe(0);
  });
});
