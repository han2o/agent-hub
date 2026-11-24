# RFC-001: Agent Hub 架构与可靠移交设计

## 1. 设计目标与约束

1. **双机异构路径与不同用户名**：Mac 与 Mac mini 同在办公网、同为 macOS，但用户名与代码根目录不同（如 `/Users/mac-user/Workspace/...` vs `/Users/mini-user/Projects/...`）。
2. **办公网安全约束**：不允许安装 Tailscale；双机通过已有 SSH 连通性建立单条双向加密转发通道，Hub 与 Companion 均只绑定 `127.0.0.1`。
3. **四个 Agent 异构存储**：
   - `pi`：`~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<uuid>.jsonl`
   - `claude`：`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
   - `qodercli`：`~/.qoder/projects/<encoded-cwd>/transcript/<uuid>.jsonl`
   - `agy`：`~/.gemini/antigravity/conversations/<uuid>.db` + `brain/<uuid>/` + `conversation_summaries.db`
4. **单向 Mac → Mini 移交**：Mini 只做被动接收者，不做激进的断网自动抢占，避免脑裂。

## 2. 系统拓扑

- **Mini (`Hub`)**：监听 `127.0.0.1:4780`，承担 Web UI、聚合大盘、Hub SQLite 状态库、Handoff Saga 编排器与 Mini 本地 `tmux`/PTY 执行。
- **Mac (`Companion`)**：监听 `127.0.0.1:4781`，负责 Mac 本地 `tmux`/PTY 会话管理、终端 Wrapper 会话登记、Git WIP 打包推送与单会话导出。
- **SSH 双向隧道（Mac `launchd` 托管）**：
  `ssh -N -L 4780:127.0.0.1:4780 -R 4781:127.0.0.1:4781 <mini-ssh-host>`

## 3. 核心可扩展接口

1. **`NodeProvider`**（`packages/hub/src/providers/`）
   - `LocalNodeProvider`（Mini 本地）
   - `HttpNodeProvider`（v1 通过隧道访问 Mac Companion）
   - *v2 扩展点*：新增 `WssNodeProvider` 即可将远端 Linux 云主机作为第三个远端节点接入，上层 UI、Saga 与 Adapter 零改动。
2. **`AgentAdapter`**（`packages/adapters/`）
   - 统一抽象 `probe`、`discoverSessions`、`buildStartCommand`、`buildResumeCommand`、`observeProgress`、`exportBundle`、`importBundle`、`buildFallbackPrompt`。
3. **`WorkspaceSyncStrategy`**（`packages/runtime/src/git-sync.ts`）
   - v1 实现基于远端 Git `origin` 的 WIP 分支策略 + `git worktree` 防冲突隔离。

## 4. Handoff Saga 状态机与可靠性保证

每次 `Mac → Mini` 移交在 Hub SQLite 中创建持久化 `handoff_jobs` 与 `handoff_steps`，并先申请 `session_leases` 乐观锁：

1. `FREEZE_SOURCE`：记录当前 `RUNNING`/`IDLE` 与完整权限参数，向 Mac `tmux` 发送中断并等待进程退出、文件刷盘。
2. `SYNC_WORKSPACE`：Mac 检查 Git 状态；如有改动切至临时分支 `wip/handoff/<branch>/<shortId>` 提交并推送 `origin`（不污染原分支）。
3. `EXPORT_SESSION`：Adapter 打包单会话最小集合（`agy` 通过 Node 24 `node:sqlite` `backup()` 在线快照防止损坏 WAL）。
4. `PREPARE_TARGET_REPO`：Mini 按「显式 `repoMappings` → 标准化 `origin` URL 匹配 → 自动 `git clone`」定位目录；若 Mini 本地仓库存在脏文件或被其它活跃会话占用，自动建 `git worktree` 检出目标 SHA。
5. `IMPORT_SESSION`：Adapter 将 `macCwd → miniCwd` 编码与内容字段全部改写后写入 Mini 对应 Agent 目录（`agy` 对 `conversation_summaries.db` 执行单行 `INSERT OR REPLACE`）。
6. `RESUME_TARGET`：Mini 在 `tmux` 中保持原权限参数执行 `resume`；若 `agy --conversation` 启动期异常退出且开启兜底，自动降级为 `agy -i` + `fallback_context.md`。若移交前为 `RUNNING`，等待 TUI 就绪后注入续跑指令。
7. `FINALIZE`：Mac 侧标记 `HANDED_OFF`，释放临时锁，Web 控制台自动无缝切换为 Mini 新会话 PTY 流。

若第 2–5 步任一步失败，触发安全回滚（释放租约、恢复 Mac 会话状态为可继续），Mac 上代码与会话完全保留，用户可在控制台一键重试失败的 Job。
