import { describe, expect, test } from "bun:test";
import { REPORT_TOOL_NAME, setupInsights } from "../src/insights";

type Handler = (event: any) => unknown;

interface Fake {
  options: Record<string, unknown>;
  sessionHooks: Map<string, Handler[]>;
  toolHooks: Map<string, Handler[]>;
  addedTool: any;
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
        cb({ add: (tool: any) => { addedTool = tool; fake.addedTool = tool; } });
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
  const tool = fake.addedTool;
  expect(tool.name).toBe(REPORT_TOOL_NAME);
  const result = await tool.execute({}, { sessionID });
  return JSON.parse(typeof result.content === "string" ? result.content : JSON.stringify(result.content));
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
});
