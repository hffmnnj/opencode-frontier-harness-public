import { describe, expect, it } from "bun:test";
import type { SessionHttpRequest } from "@opencode/plugin/promise/session";
import compat, { normalizeDisabledTools, setupProviderCompat } from "../src/provider-compat";
import type { PluginContext } from "../src/shared";

type Handler = (event: SessionHttpRequest) => Promise<void> | void;
const origin = "https://opencode.ai/inference/go/openai/v1";
const model = { providerID: "opencode-go", id: "muse-spark-1.3-contributor" };

function fixture(options: Record<string, unknown> = {}) {
  let handler: Handler | undefined;
  let scope: unknown;
  let disposed = false;
  const ctx = {
    options,
    session: {
      hook: async (name: string, callback: Handler, hookScope: unknown) => {
        expect(name).toBe("http.request");
        handler = callback;
        scope = hookScope;
        return { dispose: async () => { disposed = true; } };
      },
    },
  } as unknown as PluginContext;
  return {
    ctx,
    get handler(): Handler {
      if (!handler) throw new Error("http.request hook was not registered");
      return handler;
    },
    get scope() { return scope; },
    get disposed() { return disposed; },
    get registered() { return handler !== undefined; },
  };
}

function event(request: Request, selected = model): SessionHttpRequest {
  return { request, model: selected, sessionID: "ses_test", agent: "researcher", kind: "primary" } as SessionHttpRequest;
}

function request(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    ...init,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("provider compatibility", () => {
  it("none removes every offered tool while preserving encoded Responses and Chat history", async () => {
    const f = fixture();
    const cleanup = await setupProviderCompat(f.ctx);
    expect(compat.id).toBe("frontier-provider-compat");
    expect(f.scope).toEqual({ providerID: "opencode-go" });
    const history = [
      { type: "custom_tool_call", call_id: "c1", name: "shell", input: "pwd" },
      { type: "custom_tool_call_output", call_id: "c1", output: "/work" },
      { type: "function_call", call_id: "c2", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "done" },
    ];
    const messages = [
      { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "done" },
    ];
    for (const [path, historyKey, entries] of [
      ["/responses", "input", history],
      ["/chat/completions", "messages", messages],
    ] as const) {
      const original = {
        model: "muse-spark-1.3-contributor", [historyKey]: entries, tool_choice: "none",
        tools: [{ type: "function", name: "read" }, { type: "web_search" }],
        functions: [{ name: "legacy" }], function_call: { name: "legacy" },
        parallel_tool_calls: true, temperature: 0.4, metadata: { trace: "kept" },
      };
      const e = event(request(path, original));
      await f.handler(e);
      expect(await e.request.json()).toEqual({
        model: "muse-spark-1.3-contributor", [historyKey]: entries, tool_choice: "auto",
        temperature: 0.4, metadata: { trace: "kept" },
      });
    }
    await cleanup();
    expect(f.disposed).toBe(true);
  });

  it("rewriting preserves the original body, request headers, redirect and abort propagation", async () => {
    const f = fixture();
    await setupProviderCompat(f.ctx);
    const controller = new AbortController();
    const payload = { tool_choice: "none", tools: [{ type: "function", name: "f" }], input: [] };
    const original = request("/responses", payload, {
      signal: controller.signal, redirect: "manual",
      headers: { "content-type": "application/json", authorization: "Bearer fixture", "content-length": "999", "x-test": "kept" },
    });
    const e = event(original);
    await f.handler(e);
    expect(e.request).not.toBe(original);
    expect(original.bodyUsed).toBe(false);
    expect(await original.json()).toEqual(payload);
    expect(e.request.headers.get("authorization")).toBe("Bearer fixture");
    expect(e.request.headers.get("content-type")).toBe("application/json");
    expect(e.request.headers.get("x-test")).toBe("kept");
    expect(e.request.headers.has("content-length")).toBe(false);
    expect(e.request.redirect).toBe("manual");
    expect(await e.request.json()).toEqual({ tool_choice: "auto", input: [] });
    expect(e.request.signal.aborted).toBe(false);
    controller.abort();
    expect(e.request.signal.aborted).toBe(true);
  });

  it("auto, required, named and allowed-tool choices are never downgraded", async () => {
    const f = fixture();
    await setupProviderCompat(f.ctx);
    for (const choice of ["auto", "required", { type: "function", name: "read" }, { type: "allowed_tools", mode: "required", tools: [] }]) {
      const body = { tool_choice: choice, tools: [{ type: "function", name: "read" }] };
      const original = request("/responses", body);
      const e = event(original);
      await f.handler(e);
      expect(e.request).toBe(original);
      expect(await original.json()).toEqual(body);
      expect(normalizeDisabledTools(body)).toBeUndefined();
    }
  });

  it("other providers, models, hosts, paths and methods are left untouched", async () => {
    const f = fixture();
    await setupProviderCompat(f.ctx);
    const body = { tool_choice: "none", tools: [{ name: "f" }] };
    const cases = [
      event(request("/responses", body), { ...model, providerID: "other" }),
      event(request("/responses", body), { ...model, id: "muse-spark-1.3" }),
      event(new Request("https://evil.example/inference/go/openai/v1/responses", { method: "POST", body: JSON.stringify(body) })),
      event(new Request("http://opencode.ai/inference/go/openai/v1/responses", { method: "POST", body: JSON.stringify(body) })),
      event(new Request("https://opencode.ai:444/inference/go/openai/v1/responses", { method: "POST", body: JSON.stringify(body) })),
      event(request("/responses/compact", body)),
      event(request("/responses", body, { method: "PUT" })),
    ];
    for (const e of cases) {
      const original = e.request;
      await f.handler(e);
      expect(e.request).toBe(original);
      expect(await original.json()).toEqual(body);
    }
  });

  it("invalid JSON and unsupported content encoding keep the original request readable", async () => {
    const f = fixture();
    await setupProviderCompat(f.ctx);
    for (const original of [
      request("/responses", "{bad-json"),
      request("/responses", '{"tool_choice":"none","tools":[]}', { headers: { "content-encoding": "gzip" } }),
    ]) {
      const e = event(original);
      await f.handler(e);
      expect(e.request).toBe(original);
      expect(original.bodyUsed).toBe(false);
      expect(await original.text()).not.toBe("");
    }
  });

  it("enabled false skips registration and returns a safe cleanup", async () => {
    const f = fixture({ enabled: false });
    const cleanup = await setupProviderCompat(f.ctx);
    expect(f.registered).toBe(false);
    await cleanup();
  });
});
