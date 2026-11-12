# Frontier harness plugins for OpenCode V2

Three small plugins informed by [Factory's frontier-harness article](https://factory.com/news/frontier-harness). They complement existing Code Mode, prompt-cache, RTK, memory, and compaction mechanisms rather than replacing them. Built against `@opencode/plugin@2.2.1`.

## Plugins

| Plugin | Behavior | Intentionally does not do |
| --- | --- | --- |
| `frontier-loop-guard` | Advises on repeated identical failures within 16 recent executions, including interleaved calls; denies another unchanged attempt after six failures. Rejects exact edit no-ops and advises on edit/patch mismatches. | Interrupt sessions, block successful polling, apply fuzzy patches, alter permissions/provider retries, or serialize in-flight calls. |
| `frontier-compaction` | Adds continuity guidance; provides a known-cap 16,000-token fallback only when no output budget already exists. | Schedule compaction, replace supplied checkpoints, override an existing `maxTokens`, or rewrite conversation history. |
| `frontier-insights` | Exposes `frontier_report` for local observations/native counters and `frontier_outcome` for self-reported assignment results and verified-descendant aggregates. | Store transcripts/tool arguments, expose siblings or unrelated sessions, independently verify outcomes, estimate savings, or claim section changes are provider cache misses. |

The loop guard compares canonical JSON fingerprints of tool/input and content/output or error message, excluding volatile success metadata. Each session retains its last 16 observed executions plus a consecutive streak for configured thresholds above that window. Unrelated executions expire old failures, rather than immediately clearing them. A success or changed result resets the applicable exact call's failure count; a new prompt or reload clears its history. Changing successful results never form a stagnant streak, and unchanged successful results remain advisory-only. State is bounded to 128 sessions per plugin instance and can be evicted at that bound; no raw inputs, outputs, errors, or paths are retained.

Exact native `edit` calls with identical `oldString` and `newString` are rejected before execution. Known native edit/patch mismatch errors produce advice to use the returned current hunk or reread the focused range, never automatic patching or fuzzy application. Ambiguous/malformed input receives advisory guidance only. Recurring-call and mismatch notices are deduplicated within the applicable problem episode. These classifications do not change tool inputs, permissions, or provider retries.

The compaction instruction preserves the active goal and scope, completed versus unverified work, relevant paths and commands, blockers and next step, and authority constraints. Retrieved content stays untrusted, and summaries grant no new authority. The core or an earlier plugin may already supply `maxTokens`; this plugin preserves that value, so the fallback does not run on that path. A live 16k budget override was not verified or claimed. Model limits are captured at setup; reload after model-catalog changes when those limits matter.

The loop guard's advice changes the system section when it appears or disappears. The existing prompt-cache projection can re-anchor its retained snapshots on those transitions. This is a bounded trade-off for loop recovery, not a cache-neutral optimization or measured saving.

Insights reports context preparations, system/tool-definition section changes, current message/tool counts, tool outcomes and total observed elapsed milliseconds, retry decisions, and compaction preparations. It does not count these as successful model requests or completed compactions. Model baselines are isolated by provider/model/variant and bounded to 16 per session; outstanding call timing is bounded to 256. Raw native token counters and cost are session lifetime values; observations cover only the current plugin instance and may reset on reload or eviction. Concurrent tool durations are summed, not wall-clock session duration.

`toolObservations` groups observed calls by the fixed names `read`, `edit`, `patch`, `write`, `bash`, `shell`, `grep`, `glob`, `task`, `question`, and `execute`; all other names share `other`. Each observed group has `completed`, `errors` (`exactMismatch`, `ambiguousMismatch`, `loopGuard`, and `other`), `timedCalls`, and `millisTotal`. Classification recognizes only known signatures and is not an exhaustive error taxonomy. Timing spans the observed before/after hooks, excludes calls with no retained matching start, and is not model or queue timing. Report and outcome calls are excluded. No raw tool names outside the fixed groups, arguments, paths, outputs, or error content are retained in these observations; counts can be incomplete after missed hooks, capacity limits, reload, or eviction.

Assignment reports are explicitly self-reported, separate from native execution success. `frontier_outcome` replaces only the caller's latest report. It accepts `outcome` (`complete`, `partial`, or `blocked`), `checks` (`passed`, `failed`, `blocked`, `notRun` nonnegative integer counts), an optional `blocker` category (`authentication`, `environment`, `tooling`, `authorization`, or `other`), and an `artifacts` count. Complete reports cannot contain failed, blocked, or unrun checks. No free text or artifact paths are retained.

`frontier_report` adds the caller's report and aggregate counts for observed descendants whose native parent chain was verified. Children cannot see sibling or unrelated reports. Aggregates are incomplete after reload/eviction or missing ancestry; they are not a task database or independent acceptance. Retention is bounded to 128 latest reports, ancestry to 16 levels, and native lookups to 16 outstanding requests with a shared 750 ms deadline per operation. Three distinct descendants currently reporting the same blocker category produce one advisory per episode to diagnose the shared setup, not a dispatch block or automatic action.

## Install

```sh
bun install --frozen-lockfile
bun run check
```

Add independent entries to `plugins` in your V2 config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/opencode-frontier-harness/loop-guard", "options": { "enabled": true } },
    // Keep an existing prompt-cache owner after the loop guard.
    { "package": "/absolute/path/opencode-frontier-harness/compaction", "options": { "enabled": true, "summaryTokens": 16000 } },
    { "package": "/absolute/path/opencode-frontier-harness/insights", "options": { "enabled": true } }
  ]
}
```

OpenCode watches config; no server restart is needed. Keep the loop-guard entry before the existing context-cache projection, and insights after it when you want to observe that projection. Preserve unrelated entries and settings.

The package root also exports an aggregate plugin containing these three modules. Install either the aggregate or the independent entries, never both. Independent entries provide per-module options and ordering with existing plugins. Every module accepts `enabled: false`.

## Use

Ask the agent for a harness report, or discover `frontier_report` through Code Mode search and call its returned tool path with `{}`. It accepts no session selector. No extra credentials are needed.

Workers may discover `frontier_outcome` to report the current assignment, for example `{ outcome: "partial", checks: { passed: 2, failed: 0, blocked: 1, notRun: 0 }, blocker: "authentication", artifacts: 1 }`. Human-readable handoffs still provide exact commands, artifacts, and remaining gaps; the numeric report never replaces them.

## Separate compatibility candidate

`provider-compat/` is an **offline-tested, uninstalled candidate**, excluded from the aggregate. It addresses literal `tool_choice: "none"` on two exact official Go endpoint paths for the observed Go Muse model by removing all offered tools after history encoding and sending `auto`. Required and named tool choices are not weakened. It would have to load before `opencode-go-balancer`, which tracks request identity. Unsupported encodings and malformed JSON remain unchanged. Provider acceptance has not been verified. This is not a direct Muse authentication or attestation repair.

## Verification and operations

```sh
bun run typecheck
bun test tests
bun run build
```

See [deployment and rollback](docs/DEPLOY.md) and the [research and delivery report](docs/REPORT.md). No benchmark uplift, cache-hit improvement, or summary-quality improvement is claimed without comparable real-task measurements.
