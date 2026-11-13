import { Plugin } from "@opencode/plugin";
import type { PluginContext } from "./shared";

const providerID = "opencode-go";
const modelID = "muse-spark-1.3-contributor";
const paths = new Set([
  "/inference/go/openai/v1/responses",
  "/inference/go/openai/v1/chat/completions",
]);

/** Rewrite only the already-encoded disabled-tool request, preserving its history. */
export function normalizeDisabledTools(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const input = body as Record<string, unknown>;
  if (input.tool_choice !== "none") return undefined;
  const { tools: _tools, functions: _functions, function_call: _functionCall,
    parallel_tool_calls: _parallelToolCalls, ...rest } = input;
  return { ...rest, tool_choice: "auto" };
}

export async function setupProviderCompat(ctx: PluginContext): Promise<Plugin.Cleanup> {
  if (ctx.options.enabled === false) return () => {};

  const registration = await ctx.session.hook("http.request", async (event) => {
    if (event.model.providerID !== providerID || event.model.id !== modelID) return;
    const request = event.request;
    if (request.method !== "POST") return;
    const url = new URL(request.url);
    if (url.origin !== "https://opencode.ai" || url.username || url.password || !paths.has(url.pathname)) return;
    const encoding = request.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") return;

    let body: Record<string, unknown> | undefined;
    try {
      body = normalizeDisabledTools(await request.clone().json());
    } catch {
      return;
    }
    if (body === undefined) return;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    event.request = new Request(request, { headers, body: JSON.stringify(body), signal: request.signal });
  }, { providerID });

  return () => registration.dispose();
}

export default Plugin.define({ id: "hffmnnj.frontier-provider-compat", setup: setupProviderCompat });
