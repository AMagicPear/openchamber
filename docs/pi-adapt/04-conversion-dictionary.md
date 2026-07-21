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
| `abort` | stdin -> stdout response | Verified | Planned abort translation |
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

| Pi event | Phase 1 handling | Planned OpenCode-side use |
|---|---|---|
| `message_start` / `message_update` / `message_end` | Broadcast in input order | Semantic message/part SSE translation |
| `turn_start` / `turn_end` | Broadcast | Turn lifecycle conversion |
| `agent_start` | Sets manager busy | Session status and activity |
| `agent_end` | Broadcast; does not clear busy | Intermediate lifecycle only |
| `agent_settled` | Clears manager busy | Durable reconciliation boundary |
| `tool_execution_start/update/end` | Broadcast | Tool part conversion |
| `compaction_start/end` | Broadcast | Compaction status conversion |
| `thinking_level_changed` | Broadcast | Session state conversion |
| `session_info_changed` | Broadcast | Session metadata conversion |
| `extension_ui_request` | Broadcast | Permission/question/UI sidecar translation |
| `extension_error` / `error` | Broadcast | Explicit failure/error conversion |

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
| Session list/create/get/delete | Partially implemented | Active read-only list/get uses Pi session manager; create/delete remain deferred |
| Session messages/history | Partially implemented | Active branch history is converted from Pi durable entries; full alias reconciliation remains deferred |
| Durable message history | **implemented** | Active Pi branch order is encoded in lexicographically sortable OpenCode IDs; tool-loop assistant records are projected under their initiating user turn. |
| Session prompt and abort | Planned | Use `prompt`/`abort`, then convert stdout events to SSE |
| `/api/event` and `/api/global/event` SSE | Partially implemented | Pi internal `/event` and `/global/event` endpoints emit the accepted `server.connected` envelope and heartbeats through the existing proxy; live Pi translation/replay remains deferred |
| Session status | Planned | Must use live Pi events; `agent_end` alone is insufficient |
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

## Explicitly not implemented in Phase 2B

- Live Pi event translation/replay, prompt streaming, and mutation adapters.
- Archived session listing and live OpenCode-to-Pi alias binding/reconciliation.
- OpenCode SDK changes.
- Model/provider/config/MCP/permission/question emulation.
- Session mutation, prompt streaming, abort, and message persistence mapping.

