import { describe, expect, it } from "bun:test";
import { COMPACTION_CONTINUITY_GUIDANCE, setupCompaction } from "../src/compaction";
import type { PluginContext } from "../src/shared";

type CompactionEvent = {
  sessionID: string;
  agent: string;
  model: { id: string; providerID: string };
  system: Array<{ type: string; text: string }>;
  messages: Array<unknown>;
  options: { maxTokens?: number };
  tools: Record<string, never>;
  result?: { summary: string };
};

type ModelEntry = {
  providerID: string;
  id: string;
  modelID: string;
  limit: { context: number; output: number };
};

function makeContext(models: readonly ModelEntry[], options: Record<string, unknown> = {}) {
  const calls: Array<string> = [];
  let handler: ((event: CompactionEvent) => void) | undefined;
  const ctx = {
    options,
    model: { list: async () => ({ location: {}, data: models }) },
    session: {
      hook: async (name: string, callback: (event: CompactionEvent) => void) => {
        calls.push(name);
        handler = callback;
        return { dispose: async () => {} };
      },
    },
  } as unknown as PluginContext;
  return {
    ctx,
    calls,
    handler: () => {
      if (handler === undefined) throw new Error("compaction hook was not registered");
      return handler;
    },
  };
}

function makeEvent(overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    sessionID: "ses_test",
    agent: "build",
    model: { id: "model-a", providerID: "anthropic" },
    system: [],
    messages: [{ id: "msg_1" }],
    options: {},
    tools: {},
    ...overrides,
  };
}

function knownModel(output: number): ModelEntry {
  return { providerID: "anthropic", id: "model-a", modelID: "model-a", limit: { context: 200000, output } };
}

describe("compaction plugin", () => {
  it("compaction_summaryTokens_clampedToKnownModelOutputLimit", async () => {
    const { ctx, calls, handler } = makeContext([knownModel(8000)]);
    await setupCompaction(ctx);
    expect(calls).toEqual(["compaction"]);

    const event = makeEvent();
    const messages = event.messages;
    handler()(event);

    expect(event.options.maxTokens).toBe(8000);
    expect(event.system).toHaveLength(1);
    expect(event.system[0]?.text).toBe(COMPACTION_CONTINUITY_GUIDANCE);
    expect(event.messages).toBe(messages);
    expect(event.result).toBeUndefined();
  });

  it("compaction_explicitMaxTokens_retained", async () => {
    const { ctx, handler } = makeContext([knownModel(8000)]);
    await setupCompaction(ctx);

    const event = makeEvent({ options: { maxTokens: 4000 } });
    const messages = event.messages;
    handler()(event);

    expect(event.options.maxTokens).toBe(4000);
    expect(event.system).toHaveLength(1);
    expect(event.system[0]?.text).toBe(COMPACTION_CONTINUITY_GUIDANCE);
    expect(event.messages).toBe(messages);
  });

  it("compaction_suppliedCheckpoint_leavesEventUnchanged", async () => {
    const { ctx, handler } = makeContext([knownModel(8000)]);
    await setupCompaction(ctx);

    const event = makeEvent({ result: { summary: "already summarized" } });
    const before = structuredClone(event);
    handler()(event);

    expect(event).toEqual(before);
    expect(event.result).toEqual({ summary: "already summarized" });
  });

  it("compaction_unknownModel_addsGuidanceWithoutTokenOverride", async () => {
    const { ctx, handler } = makeContext([knownModel(8000)]);
    await setupCompaction(ctx);

    const event = makeEvent({ model: { id: "model-unknown", providerID: "anthropic" } });
    const messages = event.messages;
    handler()(event);

    expect(event.options.maxTokens).toBeUndefined();
    expect(event.system).toHaveLength(1);
    expect(event.system[0]?.text).toBe(COMPACTION_CONTINUITY_GUIDANCE);
    expect(event.messages).toBe(messages);
    expect(event.result).toBeUndefined();
  });
});
