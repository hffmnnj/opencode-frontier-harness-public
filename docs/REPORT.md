# Frontier harness research and implementation report

Date: 30 October 2026 UTC. Target: the existing OpenCode V2.2.1 main server.

## Executive summary

Three plugins provide repeated-tool-failure guidance, compaction continuity, and a session-scoped harness report.

The largest Factory recommendation, programmatic tool calling, was already present as native Code Mode. Existing RTK, native output limits, prompt-cache handling, background shell/subagent notices, memory, Goals, and compaction mechanisms were retained. No second runtime, output-pruning pipeline, compaction scheduler, or wakeup mechanism was introduced.

Provider authentication and attestation are separate from the optional, uninstalled provider compatibility candidate.

## Reading coverage

I read the full rendered [Factory article](https://factory.com/news/frontier-harness), dated 29 October 2026: introduction, benchmark figures, programmatic tool calling and examples, design choices, Agent Factory, cache behavior, prompt budget, bounded autonomy, hot-path profiling, application startup, final comparisons, SDK links, and complete methodology. The first researcher failed before producing a final handoff; its partial history was not counted as a completed report. I read the article directly rather than relying on that worker's completion status.

A browser worker inspected every external destination linked in the article body, plus the quickstart call to action. Coverage was the visible public page and, for GitHub, its rendered README. It did not install Factory, inspect the whole SDK repository, or follow every link recursively. Navigation, footer, social, legal, account, language, and sales links are site chrome rather than cited article sources and were not crawled. Plain-text mentions of CodeAct, Cloudflare, Anthropic, and Codex are not actual hyperlink targets in the observed article body.

| Embedded target | Coverage | What it contributes |
| --- | --- | --- |
| [Methodology](https://factory.com/news/frontier-harness#methodology), linked twice | Read in full within the article | Dates, versions, trials, reruns, pricing, matched-task comparisons, and telemetry population. |
| [Factory Desktop](https://factory.com/product/desktop) | Public product page read | Native desktop, previews, review, and cross-surface session claims; marketing claims, not tested behavior. |
| [Factory CLI](https://factory.com/product/cli) | Public product page read | Terminal workflow, sessions, missions, and install guidance; no software installed. |
| [Droid TypeScript SDK](https://github.com/Factory-AI/droid-sdk-typescript) | Repository landing page and rendered README read | `run`, `createSession`, `connectToDaemon`, streaming, custom MCP tools, and the existing-daemon integration option. Individual source files were not audited. |
| [Droid CLI quickstart](https://docs.factory.com/droid-cli/quickstart) | Public documentation page read | Installation, interactive controls, proposed diffs, approvals, and session workflow; no commands from the page were executed. |

Source assertions remain vendor assertions unless otherwise stated. The article was self-checked against its actual rendered text. Linked-page inspection was a worker's read, not independent product verification or an SDK security audit.

## Findings and their application

### 1. Programs should orchestrate dependent tool work

Factory's central change is allowing a JavaScript program to invoke many tools while retaining raw intermediate results inside that program. Its stated reasons are less context noise, fewer model round trips, and deterministic loops/checks. Its Script sandbox has no independent file, network, or system access; tools are the controlled interface. See [Programmatic tool calling and design choices](https://factory.com/news/frontier-harness).

The article also argues for whole structured results inside programs, compact edit responses, literal text without unnecessary escaping, concurrency for independent calls, bounded foreground waits, background execution, and completion notifications rather than repeated polling. Its large workflow examples mix measured Script runs with explicitly modeled direct-call alternatives. They are not independent head-to-head measurements of this OpenCode setup.

**Decision:** keep native Code Mode, native tool permissions, and native completion notices. This harness already supports programmatic tool calls and intermediate-result processing. Adding another Script runtime would duplicate a major component without evidence it improves the existing one. The article's per-model line-numbering example also argues against blanket output-format rewrites: an improvement for one family increased costs for others.

### 2. Preserve cache prefixes, and measure what changes

Factory reports append-only request growth, moving newly discovered tools to avoid prefix invalidation, and monitoring changes that break reuse. It reports a typical request reading 98% of input from cache across 20.4 million production CLI requests in the seven days to 22 October; token-weighted reuse was 91.5%, a materially different statistic. These are Factory's population and definitions, not measurements of this machine. See [Keeping the prompt cache warm and Methodology](https://factory.com/news/frontier-harness).

**Decision:** retain the existing prompt-cache plugin as the owner of context projection. Place loop guidance before it. Add bounded observation of system and tool-definition fingerprints, but do not label those changes actual wire-prefix breaks or provider cache misses. The new report does not invent a cache-hit denominator or estimate money saved.

### 3. Keep startup context small without deleting useful policy blindly

Factory reports reducing the initial request from 20,887 to 13,055 tokens, approximately 37.5%, with most savings from tool definitions and startup reminders. Its system prompt increased while other content decreased. This is evidence for reducing unnecessary repeated context, not for indiscriminately shortening every instruction. Some prose and figure percentages differ slightly; this implementation does not treat the rounded percentages as precise transferable targets. See [Cutting the base prompt by 37%](https://factory.com/news/frontier-harness).

**Decision:** do not rewrite global instructions or hide the user's tools. Native Code Mode already uses tool discovery. The new system guidance is short, conditional for the loop guard, and compaction-only for continuity.

### 4. Repeated unchanged failures need a defined next step

Factory states that three identical tool calls receive a nudge, six stop its loop, and repeats returning new results can continue. It separately describes dropped-stream recovery, empty-turn detection, hard-time-limit attempts, and larger compaction summaries. See [Bounded autonomy](https://factory.com/news/frontier-harness).

**Implementation: `frontier-loop-guard`.** Canonical fingerprints recognize identical inputs despite object key ordering. Three consecutive identical semantic observations produce generic advice. Six identical failures cause another unchanged invocation to be rejected with native `Tool.Error` and feedback to change approach. This deliberately **does not copy Factory's whole-session stop**: it blocks the repeated failing call, leaving the model able to diagnose or proceed differently. Successful repeats are never denied; changed polling results do not accumulate a stagnant streak. New user prompts, changed calls, and changed results reset the applicable state. Already-running concurrent calls are not serialized. Raw arguments, results, and error messages are not included in the advice or persisted.

Provider timeouts, stream repair, silent-turn counting, and automatic session interruption were not added. Those have different ownership and higher risks than a tool-level guard, and the existing V2 runtime already owns retry and execution lifecycle.

### 5. Compaction must retain enough working state to resume correctly

Factory says its summaries gained a 16,000-token allowance after the earlier 8,000-token cap was frequently exhausted. This is not evidence that every model or task needs a 16,000-token summary. See [Bounded autonomy](https://factory.com/news/frontier-harness).

**Implementation: `frontier-compaction`.** Add a stable instruction preserving goal and scope, completed versus unverified work, relevant exact paths and commands, blockers, next action, and existing authorization constraints. Retrieved content remains untrusted, summaries grant no new permissions, and secrets should not be persisted. A 16,000-token fallback is supplied only if no output budget already exists and a matching positive model output limit is known; it is clamped to that limit. Any existing budget from the core or an earlier plugin is preserved. The review found that older readable core code pre-populates this value, which would leave the fallback inert on that path; the running V2.2.1 request budget was not inspected. **No live 16k override is claimed.** If another plugin already supplied a checkpoint, leave the event entirely unchanged. No schedule, native checkpoint replacement, transcript rewrite, or model selection change is introduced.

During integration, I corrected a real API-boundary defect: the initial fake model catalog was synchronous, while V2.2.1 returns an asynchronous response containing `data`. Changing the fixture to the real contract exposed a failing budget assertion; awaiting the response and reading `data` corrected it. This is why an initial worker's green test claim was not treated as acceptance by itself.

### 6. Profile actual preparation and outcomes before optimizing

Factory's Agent Factory compares recurring failures across models, proposes a hypothesis, and tests changes with engineering review. Its performance sections also describe caching app catalogs, shortening preflight lookups, parallel startup work, deferring MCP initialization, shared sessions, precompiled code, and moving shutdown work off the critical path. See [The Agent Factory, Profiling the hot path, and Fast from launch](https://factory.com/news/frontier-harness).

**Implementation: `frontier-insights`.** A read-only `frontier_report` Code Mode tool reports only its caller's session. It exposes context-preparation counts, system/tool-definition section changes isolated by model/provider/variant, current message and tool counts, completed/error tool outcomes, aggregate observed tool milliseconds, retry decisions, and compaction preparations. Native session lifetime tokens and cost are separate from observations since the plugin loaded. It does not inspect transcript contents, retain payloads, export data, or create model requests. Memory bounds are 128 sessions per instance, 16 baselines per session, and 256 outstanding timings per session. Eviction or reload can reset observations; durations from concurrent calls are summed, not wall-clock time.

The report's `toolObservations` has fixed groups for `read`, `edit`, `patch`, `write`, `bash`, `shell`, `grep`, `glob`, `task`, `question`, and `execute`, with all other names grouped as `other`. Each observed group contains `completed`, `errors` (`exactMismatch`, `ambiguousMismatch`, `loopGuard`, `other`), `timedCalls`, and `millisTotal`. These error classes cover known signatures, not all causes. Timings span observed before/after hooks; missing or unretained starts are not timed, and these are not model or queue measurements. The report and outcome tools are excluded. These observations retain no arbitrary tool names, arguments, paths, outputs, or error content; missed hooks, bounded retention, reload, and eviction can leave them incomplete. Assignment outcomes and acceptance checks remain self-reported, not independently verified.

Core startup, module loading, MCP readiness, UI paint, daemon architecture, and provider inference routing were not modified. A plugin should not claim to reproduce Factory's core performance redesign. A permanent autonomous optimizer or benchmark scheduler would also exceed this bounded upgrade.

## Benchmark interpretation

The article is useful engineering evidence, but not proof these plugins improve task pass rate or cost. Its evaluation used Terminal-Bench 4 on 23–28 October 2026, three trials per task, high reasoning, and named versions including OpenCode 2.1.2, not the running 2.2.1 here. External launch/capacity/timeout failures were rerun; moderated Opus 5.5 trials were rerun with Opus 5; some Devin question stops were scored using Codex results; and missing Cursor usage was estimated in two trials. Cost/time comparisons use tasks both compared harnesses passed in all three trials, so the matched subsets can differ by comparison. Pass rates and cost/time figures should not be treated as a single unqualified population.

The displayed Sol figure has Droid at 57.6% and $0.79 per passed task, versus OpenCode at 51.0% and $0.77. That is higher displayed pass rate, not lower displayed cost versus OpenCode on that model. The Opus figure has Droid at 65.2% and $4.73 versus OpenCode at 62.1% and $6.20. These are vendor-reported results, not a reproduced benchmark, and no raw-trial reanalysis was performed here. See [the figures and methodology together](https://factory.com/news/frontier-harness#methodology).

## Checks and boundaries

Run `bun run check` for the local checks. Offline tests do not establish live provider acceptance or integration performance.

## Deliverables and rollback

- Source: `src/loop-guard.ts`, `src/compaction.ts`, `src/insights.ts`, and shared bounded-state/fingerprint helpers.
- Optional uninstalled candidate: `src/provider-compat.ts`.
- Tests: four focused files under `tests/`.
- Installation instructions and defaults: [README](../README.md).
- Operations and rollback: [DEPLOY.md](DEPLOY.md).
- JsonUI assets and reusable JSON specs: [research map](../assets/research-map.png), [verification](../assets/verification.png), [Muse diagnosis, page 1](../assets/muse-diagnosis.png), and [page 2](../assets/muse-diagnosis-2.png).

Rollback removes only the three frontier entries from the watched global config or sets their `enabled` flags false. Do not restore an entire backup over unrelated changes. No persisted transcript, custom checkpoint, credential, or database changes from these plugins need reversing. Provider compatibility remains a separate, uninstalled candidate.
