# Agent Hub

统一的 **Mac + Mac mini 多 Agent 控制台与无缝移交系统**，支持在一个 Web 控制台（支持安装为 PWA）中统一管理与接管 **`agy`、`pi`、`claude`、`qodercli`** 四款 CLI Agent。

## 核心能力

- **默认在 Mini 执行、Mac 仅作控制壳**：所有新会话默认调度到 24/7 在线的 Mac mini 上运行，Mac 合盖/断网不影响任务继续执行。
- **Mac → Mini 单向无缝移交（单会话负载分流 + 下班一键全量移交）**：
  - 优雅停止 Mac 会话并锁定，防止状态半截写坏；
  - 自动 commit 并 push 临时 Git WIP 分支（`wip/handoff/<branch>/<shortId>`）到 `origin`；
  - Mini 自动按显式映射或标准化 `origin` URL 匹配本地仓库（未 clone 时自动 clone；若 Mini 仓库有未提交改动或正被占用，自动开辟 `git worktree` 隔离防覆盖）；
  - 4 个 Agent 原生会话打包迁移与跨用户名/跨目录 `cwd` 路径自动改写（`agy` 使用 SQLite 在线备份 API + 单条索引合并，并内置版本不兼容降级兜底）；
  - Mini 保持原权限参数 `resume`，若移交前处于 `RUNNING` 自动注入续跑提示接着跑。
- **100% 原生 PTY 交互 + 实时状态观测**：`tmux` 托管生命周期 + `xterm.js` Web 终端 + 会话文件/终端双模状态识别（`RUNNING` / `WAITING_APPROVAL` / `IDLE` / `HANDING_OFF` / `HANDED_OFF`）。
- **零防火墙穿透成本**：通过一条 `launchd` 托管的双向加密 SSH 隧道（`-L 4780` + `-R 4781`）打通办公网 Mac 与 Mini。
- **兼容终端直接起会话**：提供可选 `agent-hub wrap` / zsh hook，在保留已有自定义 shell hook 的同时把终端会话登记到统一面板。

## 快速开始

```bash
pnpm install
pnpm build
pnpm test
node packages/cli/dist/index.js doctor
```

详细架构与部署指南请见：
- [RFC-001 架构设计文档](./docs/RFC-001-architecture.md)
- [Mac + Mini 双机部署手册](./docs/deployment-mac-mini.md)
