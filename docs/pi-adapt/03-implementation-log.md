# Implementation Log

## Phase 1: reliable per-session Pi RPC foundation

Status: implemented in this workspace.

### Added

- `packages/web/server/lib/pi/rpc-process-manager.js`
  - Dependency-injected child spawning and launch-spec resolution.
  - Per-live-session ownership keyed by runtime/session identity.
  - Exclusive session-path and `(cwd, sessionId)` claims, including
    authoritative identity claims for initially ID-less launches.
  - `pi --mode rpc` argument construction with fixed cwd and merged env.
  - UTF-8-safe, strict LF JSONL framing with CRLF tolerance and byte limits.
  - Correlated response handling, event broadcast, manager-owned IDs, request
    timeouts, stdin backpressure, and write-error handling.
  - Authoritative `get_state` readiness and busy tracking through
    `agent_settled`.
  - Bounded stderr diagnostics, explicit process caps, generation-safe failure
    handling, and graceful/forced shutdown with observed-close reporting.
- `packages/web/server/lib/pi/rpc-process-manager.test.js`
  - Deterministic fake child-process coverage for launch, protocol framing
    including unterminated EOF records, correlation, lifecycle failures,
    identity ownership, busy state, caps, stale generations, and teardown.
- `packages/web/server/lib/pi/DOCUMENTATION.md`
  - Module ownership, API, and protocol invariants.

### Architectural corrections from early research

- Process pooling is per live session, not per cwd. A cwd can own many session
  keys; cwd is launch context only.
- `get_state` is the verified readiness command. Other names in early research
  are not treated as implemented until verified against Pi RPC sources.
- Session discovery is deferred to a later bootstrap layer using Pi's
  `SessionManager.list`/`listAll`.
- Failure cannot be represented as authoritative empty success.

### Deliberately unchanged

No `packages/ui` files, OpenCode SDK calls, shared sync event model, OpenCode
proxy, or OpenCode lifecycle code were modified in Phase 1.

### Next phases

## Phase 2A: read-only compatibility gateway/bootstrap/history

Status: implemented as an isolated read-only compatibility layer in this
workspace. It is not a complete UI bootstrap claim and remains isolated from the
existing OpenCode lifecycle, proxy, server index, and `packages/ui`.

### Added

- `packages/web/server/lib/pi/session-repository.js` and focused tests:
  injected/default Pi `SessionManager` catalog access, brief successful caching,
  explicit invalidation, id/path indexes, directory/global listing, optional
  directory disambiguation, and active-branch opening. Catalog errors remain
  errors and preserve the prior cache.
- `packages/web/server/lib/pi/opencode-shapes.js` and focused tests:
  pure conversion to OpenCode 1.17.18 Session/GlobalSession, Project, Path, and
  message records. Durable Pi entry ids produce stable OpenCode message/part ids;
  project ids use SHA-256 of normalized cwd; parent session paths resolve through
  the repository index; tool results merge into matching ToolParts.
- `packages/web/server/lib/pi/gateway.js` and focused supertest/SDK smoke tests:
  loopback-only ephemeral lifecycle, health/path/config/project/session/status/
  history routes, structured failure responses, stable pagination headers, and
  deliberate unsupported responses for command/MCP/LSP/VCS when no provider is
  configured.
- Strict SessionInfo validation rejects missing/non-absolute directories and
  invalid dates. Experimental session pagination uses a strict modified-time
  boundary with deterministic id ordering and complete equal-time boundary
  groups; standard `/session` keeps its independent `start` behavior.
- Conversion tests cover prior-visible and durable parent fallback, Pi usage/cost/
  cache mapping, and OpenCode aborted/error types. Gateway lifecycle tests cover
  close racing an in-flight start and a fresh listener after close.
- `@earendil-works/pi-coding-agent@0.80.10` as a `packages/web` runtime
  dependency. The lockfile was regenerated with Bun.

### Contract boundary

The gateway is an internal upstream whose paths omit `/api`, matching the existing
proxy rewrite contract, but it is not wired into that proxy in Phase 2A. Pi remains
the source of durable read-only history. No session content, stderr, credentials,
or local stack traces are logged or returned. `/permission` and `/question` return
an authoritative empty list only because no pending-request store exists before
live process/extension integration.
Archived listing remains unsupported until the persistent alias sidecar exists,
so Phase 2A does not claim complete UI bootstrap coverage.

## Phase 2B: selectable read-only Pi backend and gateway lifecycle

Status: implemented as an experimental backend boundary. The default remains
OpenCode and no shared UI or OpenCode SDK/event contract was changed.

### Added

- `OPENCHAMBER_BACKEND` selector with normalized `opencode`/`pi` values and a
  clear startup error for invalid explicit values. OpenCode environment
  variables are not used as the selector.
- `gateway-lifecycle.js` integration through the existing OpenCode-named server
  lifecycle boundary. Each Pi start creates fresh RPC manager, session
  repository, and gateway resources, proves loopback `/global/health`, sets the
  existing proxy port/base URL state, and returns an idempotent process-like
  handle. Restart closes the old gateway and RPC manager before replacement;
  partial starts are cleaned up.
- Existing proxy, watcher, and graceful shutdown paths now reach Pi when
  `OPENCHAMBER_BACKEND=pi`. Pi mode ignores external OpenCode attach/probe and
  orphan-reaper behavior. Its health monitor serializes bounded probes and
  restarts only the in-process gateway.
- Read-only `/global/event` and `/event` SSE endpoints with no-cache/keep-alive
  headers, `server.connected` envelopes, validated directory metadata,
  sub-20-second comment heartbeats, client cleanup, backpressure waiting, and
  stream termination before gateway close.
- Pi process-info decision helper so Electron's detached OpenCode killer never
  receives the Pi gateway's ephemeral port.

### Phase 2B limitations

Pi agent-presence verification deliberately returns an unsupported error.
Configuration refresh may restart the gateway but does not claim agent
verification. Archived listing, models/providers, prompt/session mutations,
permissions/questions, live Pi event translation/replay, persistent message
aliasing, and full UI bootstrap remain absent. Phase 2B is not a full UI
bootstrap claim.

### Remaining Phase 2C+ work

Prompt forwarding, live SSE/event translation, abort, live status reconciliation,
model/provider behavior, and the persistent optimistic/live message alias
sidecar remain deferred. Durable read-only ids are provisional until that
aliasing and `agent_settled` reconciliation is implemented.

