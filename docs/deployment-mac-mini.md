# Mac + Mini 双机部署手册

## 1. 前置条件

确保 Mac 与 Mac mini 均已安装：
- Node.js >= 24（内置 `node:sqlite`）
- `pnpm`、`tmux`、`git`、`python3`、`sqlite3`
- 至少一个需要使用的 Agent CLI（`agy`、`pi`、`claude`、`qodercli`）
- Mac 已配置免密 SSH 登录 Mini（例如 `~/.ssh/config` 中配置了 `Host mini`）

## 2. 构建与体检

在两台机器分别拉取或同步本项目后执行：

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js doctor
```

## 3. 部署 Mini（Hub 中心）

```bash
bash scripts/install-mini.sh
```

脚本会交互/按参数生成 `~/.agent-hub/config.yaml`（设置 `role: hub`、`workspaceRoots`、`authToken` 等）并注册启动 `~/Library/LaunchAgents/com.agenthub.hub.plist`（只监听 `127.0.0.1:4780`）。

## 4. 部署 Mac（Companion + 双向 SSH 隧道）

```bash
bash scripts/install-mac.sh <mini-ssh-host> <shared-auth-token>
```

脚本会配置并拉起两个后台守护任务：
1. `com.agenthub.companion`：Mac Companion 进程，监听 `127.0.0.1:4781`。
2. `com.agenthub.tunnel`：常驻 SSH 双向隧道（`-L 4780:127.0.0.1:4780 -R 4781:127.0.0.1:4781`），断网或合盖恢复后自动重连。

完成后，直接在 Mac 浏览器打开 **`http://127.0.0.1:4780`**（推荐点击浏览器地址栏「安装为应用 / PWA」放进 Dock）。

## 5. 可选：接入 Warp / iTerm 直接敲命令的会话

如果想保留原有在终端直接敲 `pi` / `claude` / `agy` / `qodercli` 的习惯并纳入面板管理，可执行：

```bash
node packages/cli/dist/index.js shell-hooks
```

按输出提示在 `~/.zshrc` 末尾追加一行 `source ~/.agent-hub/shell-hooks.zsh` 即可（不会覆盖原有的自定义 shell 包装，可用 `AGENT_HUB_BYPASS=1` 随时临时绕过）。
