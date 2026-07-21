# Conversion Dictionary

This is the Phase 2A conversion contract. Every entry is marked **verified**,
**implemented**, **planned**, or **unsupported**. Verified means confirmed from
the authoritative Pi sources; implemented means covered by the isolated gateway
and its tests.

## Verified Pi RPC commands

| Pi RPC command | Direction | Phase 1 status | Intended classification |
|---|---|---:|---|
| `get_state` | stdin -> stdout response | Verified and used for readiness | Native/semantic translation later |
| `prompt` | stdin -> stdout response plus events | Verified | Planned prompt translation |
| `steer` | stdin -> stdout response plus events | Verified | Planned |
| `follow_up` | stdin -> stdout response plus events | Verified | Planned |
| `abort` | stdin -> stdout response | Verified | **implemented** — gateway POST /session/:id/abort |
| `new_session` | stdin -> stdout response plus rebinding | Verified | Planned session mutation |
| `get_messages` | stdin -> stdout response | Verified | Planned history translation |
| `get_entries` / `get_tree` | stdin -> stdout response | Verified | Planned reconciliation/history |
| `get_available_models` | stdin -> stdout response | Verified | Planned model translation |
| `set_model` / `cycle_model` | stdin -> stdout response | Verified | Planned model translation |
| `set_thinking_level` / `cycle_thinking_level` | stdin -> stdout response | Verified | Planned thinking translation |
| `get_commands` | stdin -> stdout response | Verified | Planned command translation |
| `compact` / `set_auto_compaction` | stdin -> stdout response plus events | Verified | Planned |
| `get_session_stats` | stdin -> stdout response | Verified | Planned |
| `switch_session` / `fork` / `clone` | stdin -> stdout response plus rebinding | Verified | Planned session mutation |

`--mode rpc`, `--session <absolute path>`, and `--session-id <id>` are verified
launch arguments for this adaptation's process foundation. The manager always
passes an executable and argument array and never shell-interpolates them.

## Verified Pi RPC events

| Pi event | Phase 3 handling | OpenCode-side use |
|---|---|---|
| `message_start` | Translated to provisional `message.updated` (assistant carries `path: { cwd, root }` and `parentID`) | Live message lifecycle |
| `message_update` (`text_start`/`text_delta`/`text_end`) | Per-contentIndex part updates + deltas | Live text part streaming |
| `message_update` (`thinking_start`/`thinking_delta`/`thinking_end`) | Reasoning part updates + deltas | Live reasoning part streaming |
| `message_update` (`toolcall_start`/`toolcall_delta`/`toolcall_end`) | Tool part pending with parsed JSON args | Live tool call part streaming |
| `message_end` | Final `message.updated` with tokens/cost/finish | Live message finalization |
| `turn_start` / `turn_end` | Internal step tracking | Turn lifecycle boundaries |
| `agent_start` | Translated to `session.status` (busy) | Session status and activity |
| `agent_end` | Step state cleanup | Intermediate lifecycle only |
| `agent_settled` | Translated to `session.idle` + triggers alias reconciliation | Durable reconciliation boundary |
| `tool_execution_start` | Tool part → running with `time.start` | Real tool start time captured |
| `tool_execution_update` | Tracked internally | Optional progress events |
| `tool_execution_end` | Tool part → completed/error with `time.end` | Tool part finalization |
| `compaction_start/end` | Tracked internally | Deferred |
| `thinking_level_changed` | Tracked internally | Deferred |
| `session_info_changed` | Tracked internally | Deferred |
| `extension_ui_request` | Not yet translated | Permission/question/UI sidecar translation |
| `extension_error` / `error` | Not yet translated | Deferred |

> Note: `entry_appended` fires only for extension custom entries (Pi does not
> broadcast it for normal `appendMessage` paths). Durable alias binding happens
> via the `get_entries` reconciliation pass on `agent_settled`, matched by
> accumulated content.

## Phase 2A OpenCode conversion status

| OpenCode shape or behavior | Status | Contract |
|---|---:|---|
| SessionInfo catalog validation | **implemented** | `path` and `cwd` are non-empty absolute values; `created` and `modified` are valid normalized dates. Invalid data fails rather than falling back to `process.cwd`. |
| Project/path/session conversion | **implemented** | Uses deterministic SHA-256 project ids, Pi `VERSION`, absolute directories, and durable session ids. |
| Global session ordering | **implemented** | Newest `modified` first with deterministic id tie-break. |
| `/experimental/session` pagination | **implemented** | `cursor` is a modified-time boundary (`modified < cursor`); equal-time boundary groups remain together and `x-next-cursor` strictly decreases. |
| `/session` pagination | **implemented** | Uses the installed SDK's independent `start` query; it is not the experimental cursor contract. |
| Message and ToolPart conversion | **implemented** | Visible Pi branch messages use ordinal-prefixed durable entry ids; tool results merge only with matching calls. |
| Assistant usage and failures | **implemented** | Maps Pi input/output/reasoning/cache/total/cost values; aborted maps to `MessageAbortedError`, error maps to `UnknownError`. |
| Archived session listing | **unsupported** | Deferred until live alias binding and settled reconciliation exist on top of the persistent sidecar. |

Phase 2A is a read-only active catalog/history compatibility layer, not a
complete UI bootstrap claim. It remains isolated from lifecycle, proxy, index,
SSE, and `packages/ui` integration.

## OpenCode contracts preserved at the gateway boundary

These are **verified OpenCode contracts**, not Pi commands and not Phase 1
implementations. The current UI continues to call `@opencode-ai/sdk/v2` against
the existing OpenCode-shaped surface. The eventual gateway must cover only after
the corresponding translation is designed and tested.

| OpenCode contract | Phase 2A status | Notes |
|---|---:|---|
| Session list/create/get/delete | **implemented** | List/get uses Pi session manager; create provisions live Pi RPC process; delete removes process, session file, aliases, and publishes SSE |
| Session messages/history | Partially implemented | Active branch history is converted from Pi durable entries; full alias reconciliation remains deferred |
| Durable message history | **implemented** | Active Pi branch order is encoded in lexicographically sortable OpenCode IDs; tool-loop assistant records are projected under their initiating user turn. |
| Session prompt and abort | **implemented** | Gateway sends `prompt` RPC (via prompt_async accepting SDK parts[] body, supports image-only) and `abort` RPC; prompt returns 204 No Content (matches SDK `SessionPromptAsyncResponses`); abort returns `true`; events stream through translator |
| `/api/event` and `/api/global/event` SSE | **implemented** | Pi internal `/event` and `/global/event` endpoints emit `server.connected` envelope plus translated live agent events (message.*, session.*, tool.*) through the gateway's SSE broadcaster |
| Session status | **implemented** | `agent_start` → `session.status` (busy), `agent_settled` → `session.idle`; `/session/status` also queries process manager busy state |
| Models/providers/config | **implemented** | Pi `ModelRuntime.getAvailable()` supplies authenticated selectable models; provider names come from Pi APIs; gateway defaults are deterministic and catalog failure is not an empty success. |
| Permissions/questions | Planned | Evaluate `extension_ui_request` and sidecar pending state |
| Todos/MCP/plugins/OpenCode commands | Planned or explicit unsupported | No guessed Pi command names; sidecar only where ownership is clear |

## ID and persistence rules

| Settings project discovery | **implemented** | Pi `SessionManager.listAll()` cwd values are normalized to absolute paths, deduplicated in newest-first order, and mapped with OpenChamber `createProjectIdFromPath`; existing metadata/order and `activeProjectId` win, and discovered entries are response-only. Stable timestamps use session `created`/`modified` values. Temporary/unavailable-directory filtering and hide semantics are deferred. |

**Implemented storage foundation:** `message-alias-store.js` persists a strict,
versioned alias map from OpenCode UI `messageID` to Pi durable `entryID`, with
session scoping, SHA-256 content hashes, atomic writes, and explicit malformed
storage failures. Do not use response correlation IDs as durable entry IDs.

**Planned live binding:** `reservePrompt` is intentionally absent because a live
Pi message has no durable entry id yet. Bind aliases only after `agent_settled`
reconciliation, since Pi persistence follows public `message_end` and event
receipt does not prove JSONL durability.

## Explicitly not implemented in Phase 3

- Permission/question translation from `extension_ui_request` events.
- Session update/archive/fork/title mutation routes.
- `packages/ui` SSE integration to consume live status events during generation.
- Archived session listing (requires durable alias binding for history).
- OpenCode SDK changes.

