# Pi-Adapt — 文档索引

> 本目录收纳 OpenChamber 适配 Pi 后端（`pi --mode rpc`）的设计与实现文档。

## 工作分支

`pi-adapt` — 在 `main`（OpenCode 后端）上游拉出，把后端切到 Pi。

## 文档目录

| 编号 | 文件 | 阶段 | 状态 |
|---|---|---|---|
| 01 | [`01-research.md`](./01-research.md) | 调研 | ✅ 已完成 |
| 02 | [`02-architecture.md`](./02-architecture.md) | 架构设计 | ✅ Phase 1 / 2A / 2B backend lifecycle boundary completed |
| 03 | [`03-implementation-log.md`](./03-implementation-log.md) | 实施日志（按 Phase 增量） | ✅ Phase 2B backend selection/lifecycle completed; full UI bootstrap 未完成 |
| 04 | [`04-conversion-dictionary.md`](./04-conversion-dictionary.md) | OpenCode HTTP ← → Pi RPC 命令名/事件/字段映射表 | ✅ Phase 2B read-only gateway SSE boundary added; translation remains planned |

## 命名规范

文档文件名一律 `NN-<slug>.md`，< 100 字符。

新增文档请同步加入上方表格。

## 关联来源

- 上游约束：`../..`（OpenChamber monorepo）的 `AGENTS.md`
- Pi 后端先验：`../../pi` (`/Users/amagicpear/projects/pichamber-plans/pi/`) 与早期 prototype `../../pichamber` (`/Users/amagicpear/projects/pichamber-plans/pichamber/`)
- 相关实现计划参考：`../pairing-v2-implementation-plan.md`
