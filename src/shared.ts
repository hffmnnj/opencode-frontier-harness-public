import { createHash } from "node:crypto";
import type { Plugin } from "@opencode/plugin";

export type PluginContext = Parameters<Plugin.Plugin["setup"]>[0];

/** Keep observer state bounded without persisting prompts or tool output. */
export class SessionStore<T> {
  private readonly values = new Map<string, T>();

  constructor(private readonly create: () => T, private readonly limit = 128) {}

  get(sessionID: string): T {
    const current = this.values.get(sessionID);
    if (current !== undefined) {
      this.values.delete(sessionID);
      this.values.set(sessionID, current);
      return current;
    }
    if (this.values.size >= this.limit) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    const value = this.create();
    this.values.set(sessionID, value);
    return value;
  }

  clear(): void {
    this.values.clear();
  }
}

/** Canonical object order makes semantically identical JSON inputs comparable. */
export function fingerprint(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
      }
      return item;
    });
    return encoded === undefined ? undefined : createHash("sha256").update(encoded).digest("hex");
  } catch {
    return undefined;
  }
}

export function integerOption(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}
