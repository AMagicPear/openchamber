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

### Remaining Phase 2B work

Phase 2B must integrate the gateway with OpenChamber's OpenCode lifecycle and
proxy, connect per-session `rpc-process-manager` ownership, and add the runtime
bootstrap/reconnect path. Prompt forwarding, SSE/event translation, abort, live
status reconciliation, model/provider behavior, and the persistent optimistic/live
message alias sidecar remain deferred. Durable read-only ids are provisional until
that aliasing and `agent_settled` reconciliation is implemented.

