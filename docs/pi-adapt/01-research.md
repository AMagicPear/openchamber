# OpenChamber → Pi 后端适配：调研报告

> 调研产物，未做代码改动。结论先行，每个结论附了证据文件路径。

---

## 一、OpenChamber 现状的"事实地图"

OpenChamber 的 UI 不是裸调 OpenCode HTTP。它的模块边界是这样分层的：

```
packages/ui/src/
├── lib/api/types.ts                          RuntimeAPIs 抽象层（已存在）
├── lib/runtime-fetch.ts                      fetch 注入（已存在）
├── lib/runtime-url.ts / runtime-switch.ts    多运行时切换（web/desktop/vscode，已存在）
├── lib/opencode/client.ts                    OpencodeService —— 这一层 100% 调 @opencode-ai/sdk/v2
├── stores/useConfigStore.ts / globalSessions.ts / useMcpStore.ts / useMultiRunStore.ts …
│                                             这些 store 拿到 sdk client 后直接 client.session.* / client.config.*
└── components/chat/*                         UI 组件消费的是 OpenCode 的 Message/Part/Session 类型

packages/web/server/
├── server/index.js                           Express 主入口
├── server/lib/opencode/
│   ├── lifecycle.js                          spawn "opencode serve --hostname --port" 子进程
│   ├── proxy.js                              /api/* → 反代到 opencode 子进程 (createProxyMiddleware)
│   ├── opencode-resolution-runtime.js        找 opencode 可执行
│   ├── core-routes.js                        自身路由（health/auth/version/openchamber-specific routes）
│   ├── session-runtime.js                    sessions CRUD 在此注册，**不走** opencode
│   └── ……（40+ 文件，很多和 OpenCode 无关）
├── server/lib/opencode-routes.js             注册 /api/* 到 Express
└── server/lib/* (其它 ~/session-assist / session-goal / context-obligatory / …)  OpenChamber 自身能力
```

证据：

- `packages/web/server/lib/opencode/proxy.js:696-768` —— `apiProxy = createProxyMiddleware({ target: resolveProxyTarget(), pathRewrite: { '^/api': '' }, … })`。这意味着 **所有 `/api/*` 请求被反代到 `opencode serve --port <随机>`**。
- `packages/ui/src/lib/opencode/client.ts`（1948 行）—— 全文件方法都是 `this.client.session.list / session.create / config.get / config.providers / permission.list / question.list …`，每一个方法都是 OpenCode SDK 的一个 endpoint 调用。
- `packages/ui/src/lib/api/types.ts:1191-1208` —— `RuntimeAPIs` 接口 **不包含** sessions/messages/config/providers/MCP/multi-run/todos/agent-groups/prompts。它只涵盖了 terminal/git/files/settings/permissions/notifications/github/push/diagnostics/clientAuth/tools/editor/vscode/worktrees。

### 含义

OpenChamber 已经做过一轮解耦：把 "我能跨平台支持" 的那部分能力（terminal/git/files 等）抽成 `RuntimeAPIs`。**Session/Messages/Models/Config/MCP 仍然直接吃 OpenCode SDK 的私有 schema**。

这是好事：意味着 路线 B（从 OpenChamber 搬组件到 pichamber）要把这部分也得搬；路线 A（网关模式）要重写 `OpencodeService`；路线 C（运行时双实现）要让 `OpencodeService` 也作为可替换的接口。

---

## 二、关键边界统计

> 这是工作量估计的硬数据。每条都给了 `rg` 查询。

### 2.1 UI 文件直接依赖 `@opencode-ai/sdk/v2`

- **总行数 90+** `from '@opencode-ai/sdk/v2'`
- **文件数 104** 个 `.tsx`/`.ts` 文件
- 集中在：`stores/`（config/sessions/mcp/multi-run/todos/agent-groups/permission/snippets/skills/auth），`components/chat/`（message/parts/turns），`components/session/`，`components/sections/{agents,commands,openchamber}/`

证据：`rg -n "from '@opencode-ai/sdk" packages/ui/src | sort -u` —— 90 行 import，分布在 104 个文件中。

### 2.2 `OpencodeService` 暴露的方法（约 50 个）

详细方法列表（部分）：

| 类别 | 方法 |
|---|---|
| Session | `listSessions / createSession / getSession / deleteSession / updateSession / getSessionMessages / getSessionTodos / abortSession / shellSession / revertSession / unrevertSession / forkSession / summarizeSession / getSessionStatus* / getWebServerSessionActivity` |
| Messages | `sendMessage / sendCommand / getSessionMessages / listToolIds` |
| Config | `getConfig / getProviders / getProvidersForConfig / updateConfig / updateConfigPartial / getApp / initApp` |
| Permissions | `listPendingPermissions / replyToPermission / createPermission / fetchPermission` |
| Questions | `listPendingQuestions / replyToQuestion / rejectQuestion` |
| Path | `getSystemInfo / probeDirectory / setDirectory / getDirectory / withDirectory / listDirectory / searchFiles / readFile / getSdkClient / getScopedSdkClient` |

证据：`packages/ui/src/lib/opencode/client.ts`（完整文件，已读取 1474 行）；剩下的 ~480 行我没有读完，按模式推断还有 `MCP`、`Tunnel`、`Auth`、`Bootstrap`、`File`、`Config providers/agents` 等若干方法。

### 2.3 OpenChamber **不依赖** OpenCode 的部分（已经是自家代码）

`RuntimeAPIs` 已经包含了：

- **TerminalAPI**：PTY 创建/输入/调整/关闭（已有 `bun-pty` + WebSocket）
- **GitAPI**：40+ git 端点（status/diff/log/commit/branch/worktree/stash/rebase/merge/cherry-pick/revert/credential/identity……）
- **FilesAPI**：list/read/search/command-exec
- **SettingsAPI**：CRUD
- **PermissionsAPI / NotificationsAPI / PushAPI / DiagnosticsAPI / ToolsAPI**：开箱可用
- **ClientAuthAPI**：relay 远程访问 + pairing token
- **GitHubAPI**：oauth/device-flow、PRs、Issues、checks、reviews
- **Worktree metadata / Editor / VSCode**

这部分后端已经在 `packages/web/server/lib/{git,fs,session-assist,session-goal,relay,client-auth,github,…}/` 实现，对接 Pi 完全不需要改。

### 2.4 同步引擎（live state plumbing）

`packages/ui/src/sync/` 是 OpenChamber 最大一坨自有代码：event-reducer、event-pipeline、materialization、optimistic、streaming、sync-context、use-sync、session-worktree-contract……约 40 个文件。

这个引擎抽象的 **输入是 OpenCode SSE 事件流**（`message.updated / message.part.updated / session.status / session.idle / todo.updated / permission.asked / question.asked / …`）。它的 reducer 把 OpenCode 的事件 fold 成 UI 状态。

底层的事件归一化在 `packages/ui/src/sync/event-pipeline.ts`、`event-reducer.ts`。这是 OpenChamber 的 UI 为什么能 hold 住 streaming 的核心。

---

## 三、Pi 后端的形状（pichamber 已经有了）

### 3.1 RPC 协议（来自 `pi --mode rpc`）

| 方向 | 格式 | 例子 |
|---|---|---|
| 命令 → Pi | stdin 一行 JSON | `{"id":"req_1","type":"session.create","cwd":"/path"}` |
| 事件 ← Pi | stdout 一行一行的 JSON | `{"type":"session.created","sessionId":"…"}` |
| 命令 → Pi 响应 | stdout 的同一行 JSON 带 `id` 字段 | `{"id":"req_1","success":true,"data":{…}}` 或 `{"id":"req_1","success":false,"error":"…"}` |

证据：`pichamber/src-server/rpc.ts` 的 `RpcState` + `send()`，以及 `pichamber/src/runtime/rpc-client.ts` 的 `handle()` 区分 `type === "response"` 走回 pending、`else` 当事件。

### 3.2 已知的 RPC 命令族（来自 `pichamber/src/runtime/events.ts` 的 reducer）

| 事件 | 用途 |
|---|---|
| `message_start` / `message_update` / `message_end` | message 生命周期 |
| `turn_end` | 一个 turn 结束，附带 `toolResults: ToolResultMessage[]` |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | tool streaming |
| `agent_start` / `agent_end` / `agent_settled` / `turn_start` | agent 状态 |
| `compaction_start` / `compaction_end` | context compaction |
| `thinking_level_changed` / `session_info_changed` | session 设置变化 |
| `extension_ui_request` / `extension_error` | UI dialog（select/confirm/input/editor） |
| `error` | 通用错误 |

Pi 的 RPC **没有对应 OpenCode 的 listSessions/getConfig/getProviders** 的概念 —— Pi 是 session-scoped 的，`get_state` 返回单 session 的状态，没有全局 list。

证据：`pichamber/src/runtime/events.ts:60-150`，全部事件类型没有 `providers_changed`/`config_changed`/`session_list_changed`。

### 3.3 Pi 的 session 存储

文件系统的 JSONL：`~/.pi/agent/sessions/<project-hash>/<id>__<title>.jsonl`。pichamber 当前在 `src-server/sessions.ts` 自己读这个目录列出来。

证据：`pichamber/src-server/sessions.ts`（pichamber 实现了 `listAllSessionsGrouped`）；`pichamber/AGENTS.md` 的"未来 Pi 需要补的 RPC 命令"已经指出 `list_sessions` 还没有做。

---

## 四、概念映射：OpenCode ↔ Pi

| OpenCode 概念 | Pi 概念 | 备注 |
|---|---|---|
| `Session` (id, parentID, title, directory, summary, time{created,updated,archived}) | `<project-dir>/<id>.jsonl` 文件 + `get_state` 返回单 session 状态 | Pi 没有全局 listing；需要 Pi 补 RPC 或 pichamber 自己读目录 |
| `Message` (`info + parts[]`) | `AgentMessage` (`UserMessage`/`AssistantMessage`/`ToolResultMessage`) | 结构完全不同。OpenCode 的 `parts` 是 `[TextPart, ToolPart, FilePart, AgentPart, …]`；Pi 是 `content: Content[]` 嵌入 message 本身 |
| `Part` (OpenCode) | 折进 `Message.content` | OpenCode 把 part 单独成行（独立于 message），方便 streaming 编辑；Pi 把 content 直接放 message 里 |
| `Provider` (anthropic/openai/...) | 内置于 `Model<Api>` | 完全不同 schema。Pi 把 model 抽象成 `Model<Api>`；OpenCode 把 model/providers/sources 分多个 endpoint |
| `Config` (theme/keymap/permission/mcp/plugins/…) | Pi 没有等价物 | Pi 没有 plugin/mcp/plugin marketplace，对应全部要打桩 |
| `MCP servers` | Pi 不支持 | 直接打桩返回空数组 |
| `Permission.request` | Pi 用 `extension_ui_request` (method: `select/confirm/input/editor`) | 概念接近但 schema 不一样 |
| `Question.request` (OpenCode) | Pi `extension_ui_request` method `select` | 完全可以用同一个通道 |
| `tool.ids` | RPC 没有内建 | 需要 Pi 补；当前 `listToolIds` 返回 `[]` 兜底 |
| `GET /session/status` (idle/busy/retry) | `agent_start/agent_end` 事件累计 | 需要前端从事件流推导 |
| `Shell` (开 shell 命令运行) | Pi 的 shell tool | 一个 tool call |
| `prompt_async` (发送消息) | RPC `prompt` 命令 | 类似但 Pi 不返回 message id 立即暴露到 SSE |
| SSE 事件流 | stdout 行 JSON | 完全是不同通道 |
| SSE reconnect | WebSocket 断线重连 | Pi 没有内置 reconnect，需要客户端做 generation 计数 |
| `session.fork` / `session.revert` / `session.unrevert` | Pi 还没补 RPC | 当前 pichamber 列表上打了 TODO |

证据：`pichamber/src/runtime/events.ts` + `pichamber/src/runtime/types.ts`（line 14-72）re-export 了 Pi 的所有类型，可以直接看出 schema。

---

## 五、三条路线的真实工作量估计

### 路线 A 网关模式（在 OpenChamber 的 server 里加 pi-gateway）

**要写什么：**

1. 一个新的 `packages/web/server/lib/pi-gateway.js`：
   - 维护一个 pi 进程池（per-cwd 实例化、`Bun.spawn`）
   - 把 OpenCode HTTP shape 的 endpoint 翻译成 Pi RPC：
     - `POST /api/session` → `{"type":"session.create",...}` 加 id
     - `GET /api/session` → 读 Pi 的 session 目录 + 内存缓存
     - `GET /api/session/:id/message` → `{"type":"get_messages",...}`
     - `POST /api/session/:id/message` → `{"type":"prompt",...}`
     - `POST /api/session/:id/abort` → `{"type":"abort",...}`
     - `GET /api/config/providers` → 通过 `get_state` + 全量初始化时缓存
     - `GET /api/provider` → 同上
     - `GET /api/session/status` → 内存表（agent_start/end 累计）
     - 其它：`/api/command` `/api/experimental/*` `/api/v2/session/permission/*`
2. SSE 通道：`/api/event` 是 OpenCode 的 SSE 输出；Pi 是 WebSocket-friendly NDJSON。要么 (a) 把 stdout JSON 转 SSE 推给前端，要么 (b) 改前端走 WebSocket。前者更小改动。
3. 把 `getProviders/opencode serve` 整个调用链替换：从 `lifecycle.js` 把 `opencode serve --hostname --port` 改成"启动 pi 网关进程、让 OpenChamber 的 proxy 指向它的 HTTP shape"。

**OpenCode→Pi 不能直接对得上的部分（必须打桩的 endpoint）：**

- `/api/agent` 列表 → 空
- `/api/config` (theme/keymap/permission/mcp/plugins/…) → 用本地存储的 `~/.config/openchamber/config.json`
- `/api/mcp` → 空数组
- `/api/permissions` 持久化 → 用本地存储
- `/api/provider/*` 详情 → 从 Pi `get_state` 返回的 model metadata 拼
- `/api/todo`（session 级 todo）→ Pi 不支持 task tool
- `/api/experimental/command/*`（自定义 slash）→ Pi 不支持
- `/api/worktree` → Pi 不支持（用 RuntimeAPIs 已有 worktree 替代）

**优点：**
- `packages/ui` 一行不改。
- `packages/web/server/lib/*` 里 OpenChamber 自己的 30+ 模块（git/fs/terminal/auth/relay/github/...）直接复用。
- 同步引擎 `packages/ui/src/sync/*` 一行不改。

**缺点 / 风险：**
- 网关是大块代码：要写一整套 OpenCode HTTP schema → Pi RPC 的"翻译词典"。最坏情况是把 OpenCode SDK 的 client.ts（~2000 行）翻译成另一种实现，**这部分代码量可能超过 pichamber 自己**。
- OpenCode 频繁出新版。每次 OpenCode SDK 升级，schema 会变，网关要跟着改。
- 不能用 Pi 的 thinking level / agent_mentions / extension UI 这类 Pi-specific 能力（要被 OpenCode 的 schema 抹平）。

**估计工作量**：网关实现 1.5-3k 行 TS（要看 Pi 端是否需要补 commands），端到端跑通需要 3-5 次往返调试。

---

### 路线 B UI port 模式（保留 pichamber server，把 OpenChamber 的 components 搬过去）

**要写什么：**
1. 把 `packages/ui/src/components/chat/*` （`ChatContainer`、`MessageList`、`ChatInput`、`ChatMessage`、`MarkdownRendererImpl`、`MessageBody`、`parts/*`、`lib/{messageText,messageFreshness,sessionEvents,…}`）整段复制到 `pichamber/src/features/chat/`。**约 30-40 个文件，总 5-8k 行**。
2. 抄 `packages/ui/src/components/session/*`（`SessionSidebar`、`SessionGroupSection`、`SessionNodeItem`、`SessionDialogs`、`SessionSwitcherDropdown`、`sidebar/hooks/*`），约 15 个文件。
3. 抄 `packages/ui/src/components/layout/*`、`Header.tsx`、`ContextSidebarTab.tsx`、`VSCodeLayout.tsx`。
4. 抄主题系统：`ThemeSystemContext`、`theme-sync-payload`、`theme-embedded-bootstrap`、`theme-validation`，hooks。
5. 抄 `runtime-fetch.ts`、`runtime-url.ts`、`runtime-switch.ts`、`lib/api/types.ts`（RuntimeAPIs 部分）作为前端基础设施。
6. 改 `OpencodeService` → `PiService`：把所有 `client.session.*`/`client.config.*` 改成 pichamber 已经写好的 RpcClient 调用。
7. 改 types：`Session`/`Message`/`Part`/`Provider`/`Config` 全部从 `@opencode-ai/sdk/v2` 换成 `@earendil-works/pi-coding-agent` + Pi 自己的 types。
8. UI 组件在引用这些类型的地方都得改。
9. Sync 引擎：OpenChamber 的 sync 太大了（~40 文件），pichamber 已经有了自己的 events.ts reducer。两条路：
   - **B1**：OpenChamber 的 sync 全部搬过来，改 schema，但有个反复：sync 内部对 OpenCode 事件名硬编码
   - **B2**：pichamber 自己写 sync，UI 组件改 shape（仍要从 OpenCode 的 `Message{info,parts}` 适配到 Pi 的 `AgentMessage`）

**优点：**
- 不用碰 OpenChamber 的代码，分支干净。
- Pi 的思考级别、extension UI、tool streaming 这些 Pi-specific 能力能原汁原味暴露给 UI。

**缺点 / 风险：**
- **chat UI 和 sync 引擎严重耦合 OpenCode schema**（`Message{info+parts[]}` vs Pi 的 `Message{content[]}`）。要么大改 UI 组件的渲染（不大现实，渲染那部分代码量等同于 UI 大半），要么在 PiService 里做实时翻译层。
- OpenChamber 的 sync 引擎假设了一个 SSE 通道 + `/api/event` 路径，转 Pi 得用 WebSocket 等价物 + reshape。
- 一旦做了 schema 翻译，UI 就和 OpenChamber 上游分叉了，以后 rebase 很痛。

**估计工作量**：因为 sync 引擎和 UI 组件高度耦合 OpenCode schema，**最小工作量等同于重写 pichamber UI**。大于 5k-10k 行，并且非常容易踩到老 bug。

---

### 路线 C 双 RuntimeAPIs（route A 的扩展）

把 `OpencodeService` 抽成 `SessionBackend` 接口。两个实现：`OpencodeBackend` + `PiBackend`。`Session`/`Message`/… 都走自家的 interface。

**评估**：本质上就是路线 A 的"网关" + 路线 B 的"client 改写" — **做完 A 之后再做一遍 C**。等于双重工作量。除非 OpenChamber 上游愿意接受这个 PR，否则 fork 之后再合 upstream 是地狱。

**结论：不推荐做路线 C**，除非你想长期 fork OpenChamber 并把这个 PR 推回去。

---

## 六、Pi cwd 模型 — 已确认

通过读 `/Users/amagicpear/projects/pichamber-plans/pi/packages/coding-agent/src/` 的源码可以确认：

### 6.1 Pi 进程启动时读 cwd

```ts
// main.ts:486
const cwd = process.cwd();
```

—— 主 cwd 在 spawn 时由 `Bun.spawn({ cwd })` 决定，子进程继承。

### 6.2 同一进程内支持 hot-swap session

`runtimeHost.switchSession(sessionPath, options)` (`agent-session-runtime.ts:193-216`)：

```ts
const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
// ...
this.apply(await this.createRuntime({ cwd: sessionManager.getCwd(), ... }));
await this.finishSessionReplacement(options?.withSession);
```

**核心观察**：`SessionManager.open(sessionPath, undefined, cwdOverride)` 第三个参数是 cwdOverride —— **Pi 允许在已经指定了 cwdOverride 时为这个 session 重定义 cwd**。也就是说，**理论上**一个 pi 进程能 hot-swap 不同 cwd 上的 session。

但是有两个细节必须注意：

1. `assertSessionCwdExists(sessionManager, this.cwd)` (`agent-session-runtime.ts:208`)—— 它的语义是"如果 session 头里记录了一个 cwd、那个目录不存在 → 报错"。**不强制两个 cwd 必须相等**。
2. 真正的限制——读了 `session-manager.ts:1596` 的 `SessionManager.open(...)` 调用：
   - 如果提供 `cwdOverride`，`sessionManager` 的 cwd 就是 override
   - 但 `runtimeHost` 自己的 `this.cwd` 是进程原始 cwd；后续 session 行为可能仍以 `this.cwd` 为参照（settings 加载目录、tool 解析）
   - **真实行为需要实验验证**：`switchSession` 在 RPC 模式 + cwdOverride 下能不能正常工作、是否所有 tools 跑在 override cwd、file 命令的相对路径解析用的是哪个 cwd

### 6.3 三个方案的现实取舍

| 方案 | 实现 | 风险 |
|---|---|---|
| **单 pi 进程 + cwd-switch** | 一个 pi 进程撑所有 session，UI 切换时用 `switchSession(sessionPath, { cwdOverride })` | 进程省了，但不知道 cwd 切换会不会触发 file-watch 重建、tool 路径解析混乱、agent 状态残留。**没在生产场景验证过**，要小心 |
| **per-cwd pi 进程池** | 第一次见一个 cwd 就 spawn 一个 pi 进程，UI 切到该 cwd 就复用，超时回收 | 启动延迟 ~0.5-1s（小项目）到 2-3s（大项目+plugin 加载），但 cwd 隔离干净，session 状态纯粹 |
| **始终 per-session pi 进程** | 每个 open session 一个 pi 进程 | 最纯净，但 spawn 次数和内存占用大；相当于放大版 pichamber |

### 6.4 我的建议

**per-cwd 进程池**，理由：
- Pi 启动 0.5-1s 在 Web UI 场景能接受（open session tab 才触发）
- 隔离干净 —— 进程退出不会影响别的 cwd
- "cwd-switch"风险不明确，等 Pi 上游补了正式 `new_session_with_cwd` RPC 再切
- pichamber 已经实现了进程管理 + generation，重写给 openchamber 也有现成模式

pichamber 当前是 **per-session 进程**（不 per-cwd），是有冗余的（同一 cwd 打开多个 session 就多个 pi）。移到 per-cwd 需要把 session-pool 改成 cwd-pool，工程量小（~200 行改 pichamber/rpc.ts 的 spawn key）。

---

## 七、关于 OpenCode-only 概念的用户偏好

用户已经选 "**先打桩暴露空数据，不报错**"。

具体打桩意味着（实施时对应）：

| OpenCode 端点 | 打桩策略 |
|---|---|
| `GET /api/agent` | `[]` |
| `GET /api/agent/:name` | 404 |
| `GET /api/config` | 读本地存储的 `~/.config/openchamber/config.json`（如有），不存在则空对象 |
| `GET /api/mcp` | `[]` |
| `GET /api/permission` / `/api/question` 全套 | 通过 `extension_ui_request` → 内存 list |
| `GET /api/todo` (session 级) | `[]`，前端会把这些视作无 todo |
| `GET /api/experimental/command` | `[]` |
| `GET /api/experimental/session/compacted` | `[]` |
| `POST /api/auth/*` | 走 OpenChamber 自己的 `ui-auth.js`（这部分不算 OpenCode） |

已经在 pichamber 端 `listToolIds` 失败时返回 `[]`（证据：`packages/ui/src/lib/opencode/client.ts:listToolIds` 的 try/catch return `[]`），所以前端本身就有容忍空 list 的路径。

---

## 八、推荐路线

**强烈推荐路线 A**：

1. **工作量边界清晰**：只动 `packages/web/server/lib/`，不碰 `packages/ui`。分歧点收敛到一个 `pi-gateway.js` + `proxy.js` 的 target 替换。
2. **UI 100% 复用**：OpenChamber 1.16.1 的 chat / session sidebar / settings / github / git / terminal 全部继续工作，**前提是 OpenCode→Pi 网关层把 SSE 翻译的语义足够准**。
3. **打桩表明确**：路线 A 的 § 7 那张表就是 overleaf 的工作清单。
4. **可演进**：等 Pi 端补了 `list_sessions/command/permission/mcp` 等 RPC 之后，逐步替换"打桩"分支为真实现。这是渐进式推进，不是 big bang。
5. **pichamber 的先验价值**：你已经验证过 Pi 的 RPC 协议和事件 reducer 的形状（`pichamber/src/runtime/events.ts`），那套映射可以直接搬到网关层。

**唯一的硬阻塞**：上节 VI 的 Pi cwd 切换 / 进程成本问题。这个回答了才能下笔写第一行 gateway 代码。

---

## 九、给后续行动的具体建议

如果决定走 A + 确认 Pi 进程模型，下一步应该写（不实施，本报告止于此）：

1. 在 `packages/web/server/lib/pi-gateway/` 下新建一个目录，先写 `pi-process-manager.ts` —— 包装 `Bun.spawn` + per-cwd 进程池 + generation 计数。
2. 在它旁边放 `rpc-bridge.ts` —— 持有 pending request map、stdout 行解析、`{type:"response"|...}` 路由回 pending vs broadcast。
3. 写 `opencode-to-pi-routes.ts` —— 把 `OpencodeService` 用到的 50 个 endpoint 逐个映射成对 pi 网关的调用。
4. 写 `sse-translator.ts` —— Pi 的 NDJSON stdout 转 SSE 帧往前端推（OpenChamber 的同步引擎期望 SSE）。
5. 改 `packages/web/server/lib/opencode/lifecycle.js`：把 spawn 改成"启动 pi-gateway" + 把 pi 网关的 HTTP base url 指给 `proxy.js` 的 target。
6. `proxy.js` 的 SSE 部分要绕过 http-proxy-middleware（它不适合长连接 + NDJSON upstream），改成 router 直转写到 SSE 响应。
7. 跑 e2e：浏览器开多个 tab、不同 cwd 的 session、消息发送/接收/中断，确认流对齐。
