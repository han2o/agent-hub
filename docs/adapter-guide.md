# Agent Adapter 开发指南

Agent Hub 通过 `@agent-hub/adapters` 中的 `AgentAdapter` 接口实现可插拔的 CLI Agent 支持。目前内置支持 `agy`、`pi`、`claude`、`qodercli`。

## 新增一个 Agent Adapter 的步骤

1. **在协议层注册枚举**
   - 编辑 `packages/protocol/src/types.ts` 中的 `AgentKindSchema` 与 `AppConfigSchema.agents`。
   - 若新 Agent 有特定的项目目录编码规则，在 `packages/protocol/src/paths.ts` 增加编码函数并补充单元测试。

2. **实现 `AgentAdapter` 接口**
   - 在 `packages/adapters/src/` 下新建 `<agent>.ts`，实现：
     - `probe()`：探测二进制路径、版本与本地会话目录可读性。
     - `discoverSessions(limit)`：扫描历史会话列表供 Web 端直接 Resume。
     - `findLatestSessionForCwd(cwd, sinceMs)`：用于在启动新会话或冻结算子时自动关联真实 `externalSessionId`。
     - `buildStartCommand()` / `buildResumeCommand()`：构建命令行参数，并使用 `mapPermissionFlags()` 与 `buildShellInvocation()` 保留权限配置及 zsh hook。
     - `observeProgress(session, ptyTail, processAlive)`：结合日志文件与终端尾部输出推断 `RUNNING` / `WAITING_APPROVAL` / `IDLE` / `EXITED`。
     - `exportBundle()` / `importBundle()`：打包最小必要会话文件，并在导入时借助 `rewritePath()` / `rewriteJsonlCwdLines()` 完成跨机器路径映射。

3. **注册到 `AdapterRegistry`**
   - 在 `packages/adapters/src/registry.ts` 注册新实例，并在 `packages/web` 选择器中添加对应标签即可。
