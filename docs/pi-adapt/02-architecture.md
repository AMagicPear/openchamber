# Phase 1 Architecture

## Goal and invariants

The adaptation keeps `packages/ui` unchanged. Its existing interactions,
`@opencode-ai/sdk/v2` calls, OpenCode 1.17.18 data shapes, and sync event model
are compatibility invariants. Pi types are internal implementation details and
must not leak into the shared UI contract.

The intended architecture is an internal loopback Pi Compatibility Gateway. It
will expose the OpenCode HTTP/SSE surface expected by the current proxy and UI,
while using one or more `pi --mode rpc` processes internally. The gateway is the
anti-corruption boundary: OpenCode-shaped requests and events stop there, and
OpenChamber-owned capabilities such as files, git, terminal, auth, relay, and
notifications remain reusable without being moved into Pi.

Phase 1 implements only the reliable process foundation. No HTTP route, proxy,
SSE, or existing OpenCode lifecycle wiring is changed.

## Process ownership

Process ownership is per live session, not per cwd. A key combines runtime identity
and Pi session identity. A cwd is only fixed launch context and may own many live
keys. This avoids incorrectly assuming that Pi's process-local runtime can safely
switch arbitrary sessions or cwd state. A session path is exclusively claimed by
one live key.

`createPiRpcProcessManager` provides generation-scoped ownership, concurrent
`ensureProcess` deduplication, authoritative `get_state` readiness, strict JSONL
parsing, independent request timeouts, bounded diagnostics, busy tracking, caps,
and explicit graceful/forced teardown. There is no automatic restart or eviction.
Dormant session discovery belongs to a later gateway/bootstrap layer and should
use Pi `SessionManager.list`/`listAll` rather than treating the process registry as
a session catalog.

## Compatibility boundary

The gateway will preserve the OpenCode HTTP/SSE contract at its public side:

```text
packages/ui -> @opencode-ai/sdk/v2 -> existing OpenChamber proxy/watcher
                                      -> loopback Compatibility Gateway
                                      -> per-live-session Pi RPC process
```

The gateway owns translation and reconciliation. It must distinguish capability
classes:

1. **Native translation**: Pi has an authoritative command/event with equivalent
   semantics.
2. **Semantic translation**: Pi provides the concept but fields or lifecycle need
   deliberate conversion.
3. **Sidecar emulation**: OpenChamber-owned storage/runtime supplies a capability
   outside Pi.
4. **Explicit unsupported**: no safe equivalent exists; return a deliberate
   unsupported response.

Failures must remain failures. A failed upstream operation must never become an
authoritative empty list or successful empty object that clears UI state.

## Identity and reconciliation

OpenCode message IDs and live synthetic IDs cannot be assumed to equal Pi entry
IDs. The gateway needs a persistent alias mapping from UI `messageID` and live
synthetic IDs to Pi durable entry IDs. Mapping is updated as Pi records become
durable. Reconciliation runs after `agent_settled`, because Pi persistence follows
the public `message_end` event and a preceding event is not proof that the JSONL
entry is durable.

The gateway must preserve event ordering while converting Pi stdout records to the
OpenCode SSE event model. `agent_end` is not sufficient evidence of idle; Phase 1
therefore tracks busy from `agent_start` through `agent_settled`.

## Phased plan

1. **Process foundation**: per-session RPC ownership, framing, correlation,
   readiness, failure, backpressure, bounded diagnostics, and teardown.
2. **Read-only gateway/bootstrap/history**: loopback health, session discovery via
   Pi session manager, OpenCode-shaped bootstrap and history responses, and initial
   event conversion.
3. **Prompt/SSE/abort**: prompt forwarding, streaming conversion, message aliasing,
   settled reconciliation, and abort semantics.
4. **Model/provider/thinking/commands/extension UI/session mutations**: native or
   semantic translations plus sidecar state where justified.
5. **Runtime parity**: verify web, desktop, VS Code, hosted mobile, and Capacitor
   mobile behavior through the existing runtime boundaries.

## Non-goals for Phase 1

This phase does not alter `packages/ui`, `@opencode-ai/sdk`, sync reducers, SSE
routes, OpenCode proxy/lifecycle, provider/config endpoints, session listing, or
Pi discovery. It also does not claim that guessed command names from early
research are implemented. The conversion dictionary marks verified Pi RPC
commands/events separately from OpenCode contracts and planned translations.

