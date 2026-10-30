# Deployment and rollback

## Build

From the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

Root entry shims load built JavaScript from `dist/`. Build before activation. Local development checks do not launch OpenCode hosts. Generated bundles and dependencies stay out of Git.

## Activation

Add the independent `loop-guard`, `compaction`, and `insights` package paths to the `plugins` list in your OpenCode V2 configuration. The [README](../README.md) shows the JSON shape and per-module options. Keep loop-guard before the existing prompt-cache projection and insights after it. Do not install the root aggregate as well. Keep the optional `provider-compat` candidate disabled unless it has been separately verified and deliberately selected.

OpenCode applies configuration through its existing watcher. Do not restart the main server to load these plugins. If your installation exposes the plugin API, inspect `/api/plugin` at the server's configured address; it supports the location query `location[directory]`. A plugin record must show `state.status: active`; a saved config alone is not load verification.

Discover and invoke `frontier_report` from the current session. Confirm its `sessionID` is the caller, and distinguish observations since this plugin instance from native session-lifetime counters. Read-only report invocation is safe during normal work.

## Updating

Make a topic-branch change, run `bun run check`, and rebuild. Preserve unrelated configuration. If reusing an already-loaded module path does not reload the new bundle, version the root shim's import query and save the watched configuration; verify registration rather than assuming cache invalidation. No service restart is required.

## Rollback

Remove only the three frontier entries from the watched configuration, or set their `enabled` options to `false`. Verify that the plugin entries and tool registration disappear or become inactive as appropriate. Do not restore an entire old config over concurrent changes. Unloading disposes hook registrations and clears in-memory observation state.

These plugins do not rewrite persisted transcripts, alter provider credentials, create sessions, schedule work, or persist a custom checkpoint. No database rollback is needed. Existing native compaction and other installed plugins keep their configuration.

## Provider compatibility

`provider-compat` is an optional, uninstalled candidate. It addresses literal `tool_choice: "none"` requests on specific official endpoint paths by removing offered tools after history encoding and sending `auto`. Required and named tool choices are not weakened, and unrelated requests are left unchanged. It is excluded from the aggregate, disabled by default, and has not been accepted by a live provider. If used, it must load before any request-identity balancer.

Provider-imposed client-attestation restrictions are a separate upstream boundary. They are not an expired login, and `provider-compat`, client impersonation, or attestation proxying must not be presented as a workaround. No provider credentials are inspected or persisted by these plugins.
