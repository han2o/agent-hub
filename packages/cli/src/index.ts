#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildShellInvocation,
  createDefaultRegistry
} from '@agent-hub/adapters';
import { createCompanionServer } from '@agent-hub/companion';
import { createHubServer } from '@agent-hub/hub';
import {
  AgentKindSchema,
  applyConfigDefaults,
  loadAppConfig,
  resolveDefaultConfigPath,
  saveAppConfig,
  type AgentKind,
  type AppConfig,
  type HandoffJobRecord,
  type PermissionMode
} from '@agent-hub/protocol';
import { TmuxManager } from '@agent-hub/runtime';

const execFileAsync = promisify(execFile);

function parseFlag(args: string[], flag: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      value = args[i + 1];
      i++;
    } else if (args[i].startsWith(`${flag}=`)) {
      value = args[i].slice(flag.length + 1);
    } else {
      rest.push(args[i]);
    }
  }
  return { value, rest };
}

function hasSwitch(args: string[], flag: string): { present: boolean; rest: string[] } {
  const rest = args.filter((a) => a !== flag);
  return { present: rest.length !== args.length, rest };
}

function extractPermissionAndModel(
  agent: AgentKind,
  args: string[]
): { permissionMode: PermissionMode; model: string | null } {
  let permissionMode: PermissionMode = 'default';
  let model: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--dangerously-skip-permissions') {
      permissionMode = 'bypass';
    } else if ((a === '--mode' || a === '--permission-mode') && next) {
      if (next === 'accept-edits' || next === 'accept_edits' || next === 'acceptEdits') {
        permissionMode = 'accept_edits';
      } else if (next === 'auto') {
        permissionMode = 'auto';
      } else if (next === 'plan') {
        permissionMode = 'plan';
      } else if (next === 'bypass_permissions' || next === 'bypassPermissions') {
        permissionMode = 'bypass';
      }
    } else if ((a === '--model' || a === '-m') && next) {
      model = next;
    }
  }
  if (agent === 'pi') {
    // pi uses tool allowlists rather than permission-mode flags
    permissionMode = 'default';
  }
  return { permissionMode, model };
}

async function cmdHub(args: string[]): Promise<void> {
  const cfgFlag = parseFlag(args, '--config');
  const hostFlag = parseFlag(cfgFlag.rest, '--host');
  const portFlag = parseFlag(hostFlag.rest, '--port');

  const config = loadAppConfig(cfgFlag.value);
  const effective: AppConfig = {
    ...config,
    role: 'hub',
    host: hostFlag.value ?? config.host,
    port: portFlag.value ? Number(portFlag.value) : config.port || 4780
  };

  const ctx = await createHubServer(effective);
  await ctx.app.listen({ host: effective.host, port: effective.port });
  console.log(
    `[Agent Hub] Mini Hub listening at http://${effective.host}:${effective.port} (nodeId=${effective.nodeId})`
  );

  const shutdown = async (): Promise<void> => {
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdCompanion(args: string[]): Promise<void> {
  const cfgFlag = parseFlag(args, '--config');
  const hostFlag = parseFlag(cfgFlag.rest, '--host');
  const portFlag = parseFlag(hostFlag.rest, '--port');

  const loaded = loadAppConfig(cfgFlag.value);
  const effective: AppConfig = {
    ...loaded,
    role: 'companion',
    nodeId: loaded.nodeId === 'mini' ? loaded.companionNodeId : loaded.nodeId,
    nodeName:
      loaded.nodeId === 'mini' ? loaded.companionNodeName : loaded.nodeName,
    host: hostFlag.value ?? loaded.host,
    port: portFlag.value ? Number(portFlag.value) : loaded.port === 4780 ? 4781 : loaded.port
  };

  const ctx = await createCompanionServer(effective);
  await ctx.app.listen({ host: effective.host, port: effective.port });
  console.log(
    `[Agent Hub] Mac Companion listening at http://${effective.host}:${effective.port} (nodeId=${effective.nodeId})`
  );

  const shutdown = async (): Promise<void> => {
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdWrap(args: string[]): Promise<void> {
  const rawAgent = args[0];
  if (!rawAgent) {
    console.error('Usage: agent-hub wrap <agy|pi|claude|qodercli> [-- <args...>]');
    process.exit(2);
  }
  const agent = AgentKindSchema.parse(rawAgent);
  let cliArgs = args.slice(1);
  if (cliArgs[0] === '--') cliArgs = cliArgs.slice(1);

  const config = loadAppConfig();
  const agentCfg = config.agents[agent];

  const runDirect = (): Promise<number> =>
    new Promise((resolve) => {
      const cmd = agentCfg.binary?.trim() || agent;
      const child = spawn(cmd, cliArgs, {
        stdio: 'inherit',
        env: { ...process.env, AGENT_HUB_INNER: '1' }
      });
      child.on('exit', (code) => resolve(code ?? 0));
    });

  if (process.env.AGENT_HUB_BYPASS === '1' || process.env.AGENT_HUB_INNER === '1') {
    process.exit(await runDirect());
  }

  if (process.env.TMUX) {
    try {
      const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '#S']);
      if (stdout.trim().startsWith('ah-')) {
        process.exit(await runDirect());
      }
    } catch {
      // continue to wrap
    }
  }

  const tmux = new TmuxManager({ socketName: config.tmuxSocket });
  if (!(await tmux.isAvailable())) {
    process.exit(await runDirect());
  }

  const sessionId = crypto.randomUUID();
  const tmuxName = `ah-${agent}-${sessionId.slice(0, 8)}`;
  const cwd = process.cwd();
  const bin = agentCfg.binary?.trim() || agent;
  const innerCmd = buildShellInvocation(bin, cliArgs, {
    preserveShellHooks: agentCfg.preserveShellHooks,
    shellFunctionName: agent,
    hasExplicitBinary: Boolean(agentCfg.binary?.trim())
  });
  const shellCommand = `AGENT_HUB_INNER=1 ${innerCmd}`;
  const pid = await tmux.createSession({
    name: tmuxName,
    cwd,
    shellCommand
  });

  const { permissionMode, model } = extractPermissionAndModel(agent, cliArgs);
  const companionUrl = `http://127.0.0.1:${config.role === 'companion' ? config.port : 4781}`;

  try {
    await fetch(`${companionUrl}/sessions/register-wrapped`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {})
      },
      body: JSON.stringify({
        id: sessionId,
        agent,
        cwd,
        tmuxName,
        pid,
        permissionMode,
        cliArgs,
        model
      }),
      signal: AbortSignal.timeout(2000)
    });
  } catch {
    // Non-fatal: still attach tmux seamlessly
  }

  await new Promise<void>((resolve) => {
    const attach = spawn('tmux', [...tmux.baseArgs(), 'attach-session', '-t', tmuxName], {
      stdio: 'inherit'
    });
    attach.on('exit', () => resolve());
  });

  // Check if handed off to Mini while attached
  try {
    const res = await fetch(`${companionUrl}/sessions`, {
      headers: config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {},
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      const list = (await res.json()) as { id: string; state: string }[];
      const match = list.find((s) => s.id === sessionId);
      if (match?.state === 'HANDED_OFF') {
        console.log(
          `\n[Agent Hub] 该会话 (${sessionId.slice(0, 8)}) 已移交至 Mini，请在控制台 ${config.hubUrl} 继续查看。`
        );
      }
    }
  } catch {
    // ignore
  }
}

async function cmdHandoff(args: string[]): Promise<void> {
  const allFlag = hasSwitch(args, '--all');
  const cfgFlag = parseFlag(allFlag.rest, '--config');
  const config = loadAppConfig(cfgFlag.value);
  const hubUrl = config.hubUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {})
  };

  if (allFlag.present) {
    const res = await fetch(`${hubUrl}/api/handoffs/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({})
    });
    const data = (await res.json()) as { batchId: string; jobs: HandoffJobRecord[] };
    console.log(`Batch handoff started (${data.batchId}): ${data.jobs.length} session(s)`);
    for (const job of data.jobs) {
      console.log(`  - ${job.id} (source=${job.sourceSessionId}, agent=${job.agent})`);
    }
    return;
  }

  const sessionId = cfgFlag.rest[0];
  if (!sessionId) {
    console.error('Usage: agent-hub handoff <sessionId> | --all');
    process.exit(2);
  }
  const res = await fetch(`${hubUrl}/api/handoffs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId })
  });
  const job = (await res.json()) as HandoffJobRecord;
  if (!res.ok) {
    console.error('Handoff failed to start:', job);
    process.exit(1);
  }

  console.log(`Handoff job started: ${job.id}`);
  while (true) {
    await new Promise((r) => setTimeout(r, 800));
    const poll = await fetch(`${hubUrl}/api/handoffs/${job.id}`, { headers });
    const latest = (await poll.json()) as HandoffJobRecord;
    process.stdout.write(`\rPhase: ${latest.phase} | Status: ${latest.status}          `);
    if (latest.status === 'SUCCEEDED' || latest.status === 'FAILED') {
      console.log('');
      if (latest.status === 'SUCCEEDED') {
        console.log(
          `Succeeded -> targetSession=${latest.targetSessionId} cwd=${latest.targetCwd}`
        );
      } else {
        console.error(`Failed (${latest.errorCode}): ${latest.errorMessage}`);
        process.exit(1);
      }
      break;
    }
  }
}

async function checkCmdVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 3000 });
    return (stdout || stderr).trim().split('\n')[0] || 'ok';
  } catch {
    return null;
  }
}

async function cmdDoctor(args: string[]): Promise<void> {
  const miniFlag = parseFlag(args, '--mini');
  const cfgFlag = parseFlag(miniFlag.rest, '--config');
  const config = loadAppConfig(cfgFlag.value);

  console.log('=== Agent Hub Environment Doctor ===');
  console.log(`Node.js: ${process.version}`);

  try {
    await import('node:sqlite');
    console.log('node:sqlite: OK');
  } catch (err) {
    console.log(`node:sqlite: FAIL (${err instanceof Error ? err.message : String(err)})`);
  }

  const tools: [string, string[]][] = [
    ['tmux', ['-V']],
    ['git', ['--version']],
    ['python3', ['--version']],
    ['sqlite3', ['--version']]
  ];
  for (const [cmd, tArgs] of tools) {
    const ver = await checkCmdVersion(cmd, tArgs);
    console.log(`${cmd}: ${ver ? `OK (${ver})` : 'MISSING'}`);
  }

  const ptyCheck = await checkCmdVersion('python3', [
    '-c',
    'import pty, termios, fcntl, select; print("stdlib pty ok")'
  ]);
  console.log(`python3 pty bridge deps: ${ptyCheck ?? 'MISSING'}`);

  const registry = createDefaultRegistry({
    homeDir: config.homeDir,
    dataDir: config.dataDir,
    agents: config.agents
  });
  console.log('\n--- Agent CLIs ---');
  for (const adapter of registry.list()) {
    const p = await adapter.probe();
    console.log(
      `${p.kind.padEnd(9)} installed=${p.installed ? 'YES' : 'NO '} bin=${p.binaryPath ?? '-'} ver=${p.version ?? '-'} sessionDirReadable=${p.sessionDirReadable ? 'YES' : 'NO'}`
    );
  }

  console.log('\n--- Services ---');
  for (const [label, url] of [
    ['Hub', `${config.hubUrl.replace(/\/+$/, '')}/api/health`],
    ['Companion', `${config.companionUrl.replace(/\/+$/, '')}/health`]
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      console.log(`${label} (${url}): ${res.ok ? 'ONLINE' : `HTTP ${res.status}`}`);
    } catch {
      console.log(`${label} (${url}): OFFLINE`);
    }
  }

  if (miniFlag.value) {
    try {
      const { stdout } = await execFileAsync(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', miniFlag.value, 'echo ok'],
        { timeout: 7000 }
      );
      console.log(`\nSSH (${miniFlag.value}): ${stdout.trim() === 'ok' ? 'OK' : stdout.trim()}`);
    } catch (err) {
      console.log(
        `\nSSH (${miniFlag.value}): FAIL (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }
}

function cmdInitConfig(args: string[]): void {
  const roleFlag = parseFlag(args, '--role');
  const outFlag = parseFlag(roleFlag.rest, '--output');
  const sshFlag = parseFlag(outFlag.rest, '--ssh-host');
  const tokenFlag = parseFlag(sshFlag.rest, '--token');

  const role = roleFlag.value === 'companion' ? 'companion' : 'hub';
  const outputPath = outFlag.value || resolveDefaultConfigPath();
  const cfg = applyConfigDefaults({
    role,
    port: role === 'companion' ? 4781 : 4780,
    authToken: tokenFlag.value ?? crypto.randomBytes(24).toString('hex'),
    sshHost: sshFlag.value ?? 'mini'
  });
  saveAppConfig(outputPath, cfg);
  console.log(`Generated ${role} config at ${outputPath}`);
  console.log(`authToken=${cfg.authToken}`);
}

function cmdShellHooks(): void {
  const cliEntry = path.resolve(process.argv[1]);
  console.log(`# Add to ~/.zshrc (preserves existing shell CLI wrapper hooks):
# Bypass temporarily anytime with: AGENT_HUB_BYPASS=1 claude ...

if [[ -z "\${AGENT_HUB_INNER:-}" ]]; then
  for _ah_agent in agy pi claude qodercli; do
    eval "\${_ah_agent}() {
      if [[ \"\${AGENT_HUB_BYPASS:-0}\" == \"1\" || -n \"\${AGENT_HUB_INNER:-}\" ]]; then
        command \${_ah_agent} \"\$@\"
      else
        node ${JSON.stringify(cliEntry)} wrap \${_ah_agent} -- \"\$@\"
      fi
    }"
  done
  unset _ah_agent
fi`);
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'hub':
      await cmdHub(rest);
      break;
    case 'companion':
      await cmdCompanion(rest);
      break;
    case 'wrap':
      await cmdWrap(rest);
      break;
    case 'handoff':
      await cmdHandoff(rest);
      break;
    case 'doctor':
      await cmdDoctor(rest);
      break;
    case 'init-config':
      cmdInitConfig(rest);
      break;
    case 'shell-hooks':
      cmdShellHooks();
      break;
    default:
      console.log(`Agent Hub CLI

Usage:
  agent-hub hub [--config <path>] [--host <host>] [--port <port>]
  agent-hub companion [--config <path>] [--host <host>] [--port <port>]
  agent-hub wrap <agy|pi|claude|qodercli> [-- <args...>]
  agent-hub handoff <sessionId> | --all
  agent-hub doctor [--mini <ssh-host>]
  agent-hub init-config [--role hub|companion] [--output <path>] [--ssh-host <host>] [--token <token>]
  agent-hub shell-hooks
`);
      if (sub && sub !== '--help' && sub !== '-h') process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
