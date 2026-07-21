# Pi RPC Process Manager

## Purpose

`rpc-process-manager.js` is Phase 1 of the Pi backend adaptation. It owns reliable
per-live-session `pi --mode rpc` processes and exposes a transport-neutral API for
the future internal loopback Compatibility Gateway. It does not register routes,
translate OpenCode schemas, or change `packages/ui`.

## Ownership and lifecycle

- `key` is the runtime identity plus Pi session identity. One live key owns one
  process; one cwd may own many keys.
- `sessionPath` claims are exclusive while a process is live or starting. A
  session path cannot be attached to two keys.
- `(cwd, sessionId)` claims are exclusive while a process is live or starting.
  The requested identity is reserved before spawn, and an initially ID-less
  launch claims its non-empty authoritative `get_state` identity before
  readiness. A requested identity must match the non-empty identity returned
  by `get_state`.
- Concurrent `ensureProcess` calls for the same launch identity return the same
  readiness promise.
- Readiness is authoritative: the manager sends a correlated `get_state` and
  resolves only after its successful response. There is no fixed startup sleep.
- Processes are never automatically evicted or restarted. `maxProcesses` rejects
  new work explicitly and never evicts busy work.

## Public API

`createPiRpcProcessManager(options)` returns:

- `ensureProcess({ key, cwd, sessionPath?, sessionId? })`: starts or deduplicates
  a process and resolves to `{ key, generation, cwd, sessionPath, sessionId,
  state }` after `get_state` readiness.
- `request(key, command, { timeoutMs? })`: sends a command with a manager-owned
  correlation id and resolves with response `data`. Failed responses and timeouts
  reject, and pending entries are always removed.
- `subscribe(key, listener)`: receives valid non-correlated stdout records in
  input order, plus one bounded lifecycle record for unexpected process failure.
  Listener exceptions cannot interrupt protocol processing.
- `stopProcess(key)`: rejects pending work, releases manager ownership, closes
  stdin, terminates the detached process group, and escalates to a forced kill
  after the configured timeout. It resolves `true` only when a child `close`
  event is observed; it resolves `false` when force termination is not
  confirmed, so shutdown does not hang on a child that never closes.
- `getSnapshot()`: returns non-content process identity/status and bounded stderr
  byte diagnostics. It never includes stdout, stderr, prompts, or response data.
- `shutdown()`: idempotently stops every process.

The manager accepts `spawnProcess` and `resolveLaunchSpec` injections for tests and
packaged launch behavior. The default launch command is `PI_BINARY`, then
`PICHAMBER_PI_PATH`, then `pi`. Launches use an executable plus argument array,
inherit `process.env` with launch env merged on top, fixed `cwd`, piped stdin/stdout/
stderr, detached Unix process groups, and `windowsHide`.

## Protocol invariants

Stdout is parsed as strict LF-delimited JSON using `StringDecoder('utf8')`. CRLF
is accepted; U+2028 and U+2029 remain payload characters. At stream EOF, a
non-empty unterminated final line is parsed as one record, matching Pi's JSONL
reader. Malformed JSON and records over `maxJsonlRecordBytes` fail the process.
Only `{ type: 'response', id: string }` records correlate with pending
commands. Every other valid JSON record, including unmatched responses, is
broadcast.

Busy state starts at `agent_start` and ends at `agent_settled`; `agent_end` does
not make a process idle. Failure, protocol error, and unexpected exit reject all
pending calls and emit one lifecycle record. Generation checks prevent stale close
events from deleting or failing a replacement process.

The manager drains stderr without exposing its contents. It only retains a bounded
byte count in snapshots. It does not log commands, prompts, payloads, stderr, or
credentials.

## Phase 2A: read-only compatibility gateway

Phase 2A adds three intentionally standalone modules:

- `session-repository.js` uses the injected or installed Pi `SessionManager.list`,
  `listAll`, and `open` APIs. Successful catalogs are cached briefly and indexed by
  session id and absolute session path. Every durable entry must have non-empty
  absolute `path` and `cwd` values plus valid `created` and `modified` dates;
  accepted date strings/numbers are normalized to `Date`. A refresh or validation
  error is rethrown and leaves the previous cache untouched; `invalidate()` is
  explicit. A global lookup rejects duplicate Pi session ids across directories;
  callers must provide a directory instead of silently opening the wrong session.
- `opencode-shapes.js` is a pure Pi-to-OpenCode 1.17.18 conversion boundary. It
  uses a fixed-width active-branch ordinal plus the Pi durable entry id for
  message and part IDs, so OpenChamber's lexicographic history ordering remains
  root-to-leaf chronological. Each assistant record after a visible user is
  parented to that user for OpenChamber turn projection; this deliberately
  differs from Pi's execution-tree parentage during tool loops. It otherwise
  uses SHA-256 project ids, Pi `VERSION`, active branch entries, and
  parent-session path resolution through the catalog index. Compaction, branch
  summary, and other non-message entries are omitted. Tool results merge into
  matching assistant ToolParts; unmatched or missing results do not remove
  unrelated records.
- `gateway.js` creates an Express app plus an optional ephemeral loopback listener.
  It exposes only read-only OpenCode-shaped bootstrap/history routes, validates
  explicit absolute existing directories, returns generic structured errors, and
  uses deliberate 501 responses for deferred capabilities. Experimental session
  pagination uses a strict modified-time boundary, deterministic id tie-breaks,
  and complete equal-time boundary groups so `x-next-cursor` remains numeric and
  strictly decreasing. Standard `/session` keeps the SDK's independent `start`
  semantics. Start/close are idempotent, including close racing an in-flight
  start. In Phase 2B it is registered only by the Pi lifecycle and reached
  through the existing OpenChamber proxy.

Durable history ids in this phase are provisional. Phase 3 must add the persistent
OpenCode/live-to-Pi alias sidecar and settled reconciliation before prompt and SSE
flows can claim complete identity parity. `/permission` and `/question` currently
return `[]` because the pending-request store is authoritatively empty before live
Pi processes/extensions exist; this is not an archive or failure fallback.
Archived listing remains unsupported until the persistent alias sidecar exists.
Phase 2A is therefore not a complete UI bootstrap claim.

## Phase 2B: backend selector and lifecycle

Set `OPENCHAMBER_BACKEND=pi` to select the experimental read-only Pi backend.
Values are case- and whitespace-normalized; only `opencode` and `pi` are
supported. The default is `opencode`, and invalid explicit values fail clearly at
startup. `OPENCHAMBER_BACKEND` is independent of all `OPENCODE_*` variables.

`gateway-lifecycle.js` exposes the OpenCode-named lifecycle methods consumed by
the existing server composition. In Pi mode, every managed start creates a fresh
RPC process manager, session repository, and compatibility gateway. The gateway
binds only to loopback on an ephemeral port, is checked through
`/global/health`, and is represented to proxy and shutdown code as
`{ url, pid: null, close() }`. Closing that handle stops the gateway before all
Pi RPC processes; restart and partial-start cleanup are idempotent.

The gateway's read-only `/global/event` and `/event` endpoints emit an initial
`server.connected` SSE payload, preserve validated directory metadata for the
scoped endpoint, and send frequent comment heartbeats. They do not translate or
replay live Pi events. Pi health monitoring probes only this in-process gateway,
never external `OPENCODE_HOST`/`OPENCODE_PORT` endpoints and never runs the
OpenCode orphan reaper. Agent-presence verification, archived listing, prompt/
session mutation, and live event translation remain unsupported. Model/provider
and primary-agent bootstrap are translated from Pi's authenticated catalog.

## Phase 2D: model and agent bootstrap

`model-catalog.js` creates Pi's exported `ModelRuntime` and uses its
auth-filtered `getAvailable()` result, with `ModelRegistry` provider display
metadata. It never serializes credentials, auth values, headers, environment
values, or request configuration. Successful snapshots are cached for a
bounded TTL, concurrent reads share one initialization, failures remain
failures for retry, and `invalidate()` explicitly clears the snapshot.

The gateway exposes OpenCode 1.17.18-compatible `GET /config/providers`,
`GET /provider`, and `GET /agent` responses. `/config` and `/global/config`
preserve the injected config object and add a deterministic `provider/model`
default only after a successful catalog read. A zero-model result is a valid
empty catalog when Pi authoritatively reports no authenticated models; runtime
initialization or catalog failures are HTTP failures. The sole `pi` agent is a
native primary-agent bridge for OpenChamber selection and does not represent
Pi subagents.

## Pi project discovery for settings

`project-discovery.js` augments the formatted `/api/config/settings` GET and PUT
responses when `OPENCHAMBER_BACKEND=pi`. It calls the installed Pi
`SessionManager.listAll()` catalog, collects unique absolute `SessionInfo.cwd`
values in Pi's newest-first order, and creates normal OpenChamber project
entries with `createProjectIdFromPath`. Existing settings entries retain their
metadata and order; discovered entries are response-only and never persisted.
Their timestamps come from session `created`/`modified` values, avoiding
`Date.now()` churn. Catalog failure remains an HTTP failure rather than an
authoritative settings response with missing projects.

Temporary/unavailable-directory filtering and user-facing hide semantics are
intentionally deferred. This phase prioritizes complete catalog coverage.

## Phase boundary

The future Compatibility Gateway will translate OpenCode 1.17.18 HTTP/SSE at the
loopback boundary while preserving the existing SDK and UI contracts. This module
is intentionally usable by that gateway without coupling the process foundation
to HTTP routing or OpenCode lifecycle code.

