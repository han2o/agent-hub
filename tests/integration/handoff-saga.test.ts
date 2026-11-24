import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCompanionServer, type CompanionServerContext } from '@agent-hub/companion';
import { createHubServer, type HubServerContext } from '@agent-hub/hub';
import {
  applyConfigDefaults,
  encodePiSessionDirName,
  type HandoffJobRecord,
  type SessionRecord
} from '@agent-hub/protocol';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  }).trim();
}

function initBareOriginAndSeed(root: string, name: string): { bare: string; seed: string } {
  const bare = path.join(root, `${name}.git`);
  const seed = path.join(root, `${name}-seed`);
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '--bare', bare]);
  git(['clone', bare, seed]);
  git(['checkout', '-b', 'main'], seed);
  fs.writeFileSync(path.join(seed, 'app.txt'), `seed-${name}\n`, 'utf8');
  git(['add', 'app.txt'], seed);
  git(['commit', '-m', 'seed commit'], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  return { bare, seed };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 6000,
  intervalMs = 150
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('End-to-end Mac -> Mini Handoff Saga integration', () => {
  let tmpRoot: string;
  let macHome: string;
  let miniHome: string;
  let macWs: string;
  let miniWs: string;
  let macSocket: string;
  let miniSocket: string;
  let fakePiLogPath: string;
  let fakePiBin: string;

  let companion: CompanionServerContext;
  let hub: HubServerContext;
  let hubBaseUrl: string;

  let macRepo1: string;
  let miniRepo1: string;
  let macRepoRetry: string;
  let bareRetryOrigin: string;
  let macRepoBatchA: string;
  let macRepoBatchB: string;

  beforeAll(async () => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-integ-')));
    macHome = path.join(tmpRoot, 'mac-user');
    miniHome = path.join(tmpRoot, 'mini-user');
    macWs = path.join(macHome, 'MacWork');
    miniWs = path.join(miniHome, 'MiniProjects');
    fs.mkdirSync(macWs, { recursive: true });
    fs.mkdirSync(miniWs, { recursive: true });

    const rand = Math.random().toString(36).slice(2, 8);
    macSocket = `ah-test-mac-${rand}`;
    miniSocket = `ah-test-mini-${rand}`;

    const origin1 = initBareOriginAndSeed(tmpRoot, 'repo1');
    macRepo1 = path.join(macWs, 'repo-one');
    miniRepo1 = path.join(miniWs, 'repo-one-mini');
    git(['clone', origin1.bare, macRepo1]);
    git(['clone', origin1.bare, miniRepo1]);

    // Repo without origin initially for failure + retry test
    macRepoRetry = path.join(macWs, 'repo-retry');
    fs.mkdirSync(macRepoRetry, { recursive: true });
    git(['init'], macRepoRetry);
    git(['checkout', '-b', 'main'], macRepoRetry);
    fs.writeFileSync(path.join(macRepoRetry, 'retry.txt'), 'initial retry\n', 'utf8');
    git(['add', 'retry.txt'], macRepoRetry);
    git(['commit', '-m', 'init retry'], macRepoRetry);

    bareRetryOrigin = path.join(tmpRoot, 'repo-retry.git');
    fs.mkdirSync(bareRetryOrigin, { recursive: true });
    git(['init', '--bare', bareRetryOrigin]);

    // Repos for batch handoff test
    const originA = initBareOriginAndSeed(tmpRoot, 'batch-a');
    const originB = initBareOriginAndSeed(tmpRoot, 'batch-b');
    macRepoBatchA = path.join(macWs, 'batch-a');
    macRepoBatchB = path.join(macWs, 'batch-b');
    git(['clone', originA.bare, macRepoBatchA]);
    git(['clone', originB.bare, macRepoBatchB]);

    // Fake pi executable simulating interactive pi CLI
    fakePiLogPath = path.join(tmpRoot, 'fake-pi-log.jsonl');
    const binDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fakePiBin = path.join(binDir, 'fake-pi.mjs');

    const fakePiCode = `#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const MAC_HOME = ${JSON.stringify(macHome)};
const LOG_PATH = ${JSON.stringify(fakePiLogPath)};
const args = process.argv.slice(2);
const cwd = process.cwd();
const sessionIdx = args.indexOf('--session');
const isResume = sessionIdx !== -1 && args[sessionIdx + 1];

function encodePiDir(p) {
  const cleaned = path.posix.normalize(p).replace(/^\\/+|\\/+$/g, '').replace(/\\//g, '-') || 'root';
  return '--' + cleaned + '--';
}

let sessionFile = isResume ? args[sessionIdx + 1] : null;
if (!isResume) {
  const id = crypto.randomUUID();
  const dir = path.join(MAC_HOME, '.pi', 'agent', 'sessions', encodePiDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  sessionFile = path.join(dir, '2026-11-24T12-00-00-000Z_' + id + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd }),
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: args[args.length - 1] || 'start' }] }),
    JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Working on task...' }] })
  ];
  fs.writeFileSync(sessionFile, lines.join('\\n') + '\\n', 'utf8');
}

fs.appendFileSync(LOG_PATH, JSON.stringify({ event: 'start', isResume: Boolean(isResume), cwd, args, sessionFile }) + '\\n');
process.stdout.write('fake-pi ready (' + (isResume ? 'resume' : 'new') + ')\\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ event: 'stdin', cwd, isResume: Boolean(isResume), line }) + '\\n');
});
const keepAlive = setInterval(() => {}, 5000);
function shutdown() {
  clearInterval(keepAlive);
  rl.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;
    fs.writeFileSync(fakePiBin, fakePiCode, 'utf8');
    fs.chmodSync(fakePiBin, 0o755);

    const sharedToken = 'integ-secret-token';
    const macConfig = applyConfigDefaults({
      role: 'companion',
      nodeId: 'mac',
      nodeName: 'Test Mac',
      host: '127.0.0.1',
      port: 0,
      authToken: sharedToken,
      homeDir: macHome,
      workspaceRoots: [macWs],
      worktreesRoot: path.join(macHome, '.agent-hub', 'worktrees'),
      dataDir: path.join(macHome, '.agent-hub'),
      tmuxSocket: macSocket,
      agents: {
        pi: { binary: fakePiBin, preserveShellHooks: false, defaultArgs: [] },
        agy: { binary: '', preserveShellHooks: false, defaultArgs: [] },
        claude: { binary: '', preserveShellHooks: false, defaultArgs: [] },
        qodercli: { binary: '', preserveShellHooks: false, defaultArgs: [] }
      }
    });

    companion = await createCompanionServer(macConfig);
    await companion.app.listen({ host: '127.0.0.1', port: 0 });
    const compAddr = companion.app.server.address();
    const compPort = typeof compAddr === 'object' && compAddr ? compAddr.port : 4781;

    const miniConfig = applyConfigDefaults({
      role: 'hub',
      nodeId: 'mini',
      nodeName: 'Test Mini',
      host: '127.0.0.1',
      port: 0,
      authToken: sharedToken,
      homeDir: miniHome,
      workspaceRoots: [miniWs],
      worktreesRoot: path.join(miniHome, '.agent-hub', 'worktrees'),
      dataDir: path.join(miniHome, '.agent-hub'),
      tmuxSocket: miniSocket,
      companionUrl: `http://127.0.0.1:${compPort}`,
      companionNodeId: 'mac',
      companionNodeName: 'Test Mac',
      agents: {
        pi: { binary: fakePiBin, preserveShellHooks: false, defaultArgs: [] },
        agy: { binary: '', preserveShellHooks: false, defaultArgs: [] },
        claude: { binary: '', preserveShellHooks: false, defaultArgs: [] },
        qodercli: { binary: '', preserveShellHooks: false, defaultArgs: [] }
      }
    });

    hub = await createHubServer(miniConfig, {
      pollIntervalMs: 0,
      sagaOptions: { startupVerifyDelayMs: 250 }
    });
    await hub.app.listen({ host: '127.0.0.1', port: 0 });
    const hubAddr = hub.app.server.address();
    const hubPort = typeof hubAddr === 'object' && hubAddr ? hubAddr.port : 4780;
    hubBaseUrl = `http://127.0.0.1:${hubPort}`;
    await hub.pollOnce();
  });

  afterAll(async () => {
    await hub?.close().catch(() => {});
    await companion?.close().catch(() => {});
    for (const sock of [macSocket, miniSocket]) {
      try {
        execFileSync('tmux', ['-L', sock, 'kill-server']);
      } catch {
        // ignore if no server running
      }
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer integ-secret-token'
  };

  it('hands off an active Mac pi session with uncommitted git edits to Mini, rewrites cwd, preserves flags, and injects continuation prompt', async () => {
    const startRes = await fetch(`${hubBaseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        nodeId: 'mac',
        agent: 'pi',
        cwd: macRepo1,
        title: 'Repo1 bugfix',
        model: 'test-model-v1',
        extraArgs: ['--thinking', 'high'],
        initialPrompt: 'fix repo1 bug'
      })
    });
    expect(startRes.status).toBe(200);
    const macSession = (await startRes.json()) as SessionRecord;

    // Wait for fake-pi to create its JSONL file on Mac
    const piDir = path.join(
      macHome,
      '.pi',
      'agent',
      'sessions',
      encodePiSessionDirName(macRepo1)
    );
    await waitUntil(
      () => fs.existsSync(piDir) && fs.readdirSync(piDir).some((f) => f.endsWith('.jsonl'))
    );

    // Simulate uncommitted work on Mac
    fs.writeFileSync(path.join(macRepo1, 'app.txt'), 'edited on mac before handoff\n', 'utf8');
    fs.writeFileSync(path.join(macRepo1, 'feature.ts'), 'export const x = 42;\n', 'utf8');

    const handoffRes = await fetch(`${hubBaseUrl}/api/handoffs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ sessionId: macSession.id })
    });
    expect(handoffRes.status).toBe(200);
    const createdJob = (await handoffRes.json()) as HandoffJobRecord;

    const doneJob = await hub.saga.waitForJob(createdJob.id);
    expect(doneJob.status).toBe('SUCCEEDED');
    expect(doneJob.steps.every((s) => s.status === 'SUCCEEDED')).toBe(true);
    expect(doneJob.wipBranch).toContain('wip/handoff/');
    expect(doneJob.targetCwd).toBe(miniRepo1);
    expect(doneJob.targetSessionId).toBeTruthy();

    // Verify dirty code synced to Mini
    expect(fs.readFileSync(path.join(miniRepo1, 'app.txt'), 'utf8')).toBe(
      'edited on mac before handoff\n'
    );
    expect(fs.readFileSync(path.join(miniRepo1, 'feature.ts'), 'utf8')).toBe(
      'export const x = 42;\n'
    );

    // Verify Pi JSONL imported with rewritten cwd under Mini home
    const miniPiDir = path.join(
      miniHome,
      '.pi',
      'agent',
      'sessions',
      encodePiSessionDirName(miniRepo1)
    );
    expect(fs.existsSync(miniPiDir)).toBe(true);
    const miniJsonlName = fs.readdirSync(miniPiDir).find((f) => f.endsWith('.jsonl'))!;
    const miniHeader = JSON.parse(
      fs.readFileSync(path.join(miniPiDir, miniJsonlName), 'utf8').split('\n')[0]
    ) as { cwd: string };
    expect(miniHeader.cwd).toBe(miniRepo1);

    // Verify Mini fake-pi started with --session + preserved flags AND received continuation prompt
    await waitUntil(() => {
      const logLines = fs.readFileSync(fakePiLogPath, 'utf8').trim().split('\n');
      const entries = logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
      return entries.some(
        (e) =>
          e.event === 'stdin' &&
          e.isResume === true &&
          e.cwd === miniRepo1 &&
          String(e.line).includes('[Agent Hub 移交续跑]')
      );
    }, 6000);

    const logEntries = fs
      .readFileSync(fakePiLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; isResume?: boolean; cwd?: string; args?: string[] });

    const resumeStart = logEntries.find(
      (e) => e.event === 'start' && e.isResume === true && e.cwd === miniRepo1
    );
    expect(resumeStart).toBeTruthy();
    expect(resumeStart!.args).toContain('--session');
    expect(resumeStart!.args).toContain('--model');
    expect(resumeStart!.args).toContain('test-model-v1');
    expect(resumeStart!.args).toContain('--thinking');
    expect(resumeStart!.args).toContain('high');

    // Verify source session marked HANDED_OFF
    const updatedSourceRes = await fetch(
      `${hubBaseUrl}/api/sessions/${macSession.id}`,
      { headers: authHeaders }
    );
    const updatedSource = (await updatedSourceRes.json()) as SessionRecord;
    expect(updatedSource.state).toBe('HANDED_OFF');
    expect(updatedSource.handedOffToSessionId).toBe(doneJob.targetSessionId);
  });

  it('rolls back cleanly on SYNC_WORKSPACE failure and succeeds on retry after fixing remote', async () => {
    const startRes = await fetch(`${hubBaseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        nodeId: 'mac',
        agent: 'pi',
        cwd: macRepoRetry,
        title: 'Retry test',
        initialPrompt: 'test retry'
      })
    });
    const session = (await startRes.json()) as SessionRecord;

    const piDir = path.join(
      macHome,
      '.pi',
      'agent',
      'sessions',
      encodePiSessionDirName(macRepoRetry)
    );
    await waitUntil(
      () => fs.existsSync(piDir) && fs.readdirSync(piDir).some((f) => f.endsWith('.jsonl'))
    );

    const failStart = await fetch(`${hubBaseUrl}/api/handoffs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ sessionId: session.id })
    });
    const job = (await failStart.json()) as HandoffJobRecord;
    const failed = await hub.saga.waitForJob(job.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.errorCode).toBe('GIT_SYNC_FAILED');

    // Verify source session rolled back out of HANDING_OFF
    const afterFailRes = await fetch(`${hubBaseUrl}/api/sessions/${session.id}`, {
      headers: authHeaders
    });
    const afterFail = (await afterFailRes.json()) as SessionRecord;
    expect(afterFail.state).toBe('EXITED');

    // Now add the missing origin remote and retry!
    git(['remote', 'add', 'origin', bareRetryOrigin], macRepoRetry);
    fs.writeFileSync(path.join(macRepoRetry, 'retry.txt'), 'fixed and retried\n', 'utf8');

    const retryRes = await fetch(`${hubBaseUrl}/api/handoffs/${job.id}/retry`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}'
    });
    expect(retryRes.status).toBe(200);
    const retried = await hub.saga.waitForJob(job.id);
    expect(retried.status).toBe('SUCCEEDED');
    expect(retried.targetCwd).toBeTruthy();
    expect(fs.readFileSync(path.join(retried.targetCwd!, 'retry.txt'), 'utf8')).toBe(
      'fixed and retried\n'
    );
  });

  it('executes end-of-day batch handoff for remaining active Mac sessions', async () => {
    const startA = await fetch(`${hubBaseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        nodeId: 'mac',
        agent: 'pi',
        cwd: macRepoBatchA,
        title: 'Batch A',
        initialPrompt: 'work A'
      })
    });
    const sessA = (await startA.json()) as SessionRecord;

    const startB = await fetch(`${hubBaseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        nodeId: 'mac',
        agent: 'pi',
        cwd: macRepoBatchB,
        title: 'Batch B',
        initialPrompt: 'work B'
      })
    });
    const sessB = (await startB.json()) as SessionRecord;

    await waitUntil(() => {
      const dA = path.join(
        macHome,
        '.pi',
        'agent',
        'sessions',
        encodePiSessionDirName(macRepoBatchA)
      );
      const dB = path.join(
        macHome,
        '.pi',
        'agent',
        'sessions',
        encodePiSessionDirName(macRepoBatchB)
      );
      return (
        fs.existsSync(dA) &&
        fs.readdirSync(dA).some((f) => f.endsWith('.jsonl')) &&
        fs.existsSync(dB) &&
        fs.readdirSync(dB).some((f) => f.endsWith('.jsonl'))
      );
    });

    const batchRes = await fetch(`${hubBaseUrl}/api/handoffs/batch`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ sessionIds: [sessA.id, sessB.id] })
    });
    expect(batchRes.status).toBe(200);
    const batch = (await batchRes.json()) as { batchId: string; jobs: HandoffJobRecord[] };
    expect(batch.jobs).toHaveLength(2);

    const results = await Promise.all(batch.jobs.map((j) => hub.saga.waitForJob(j.id)));
    expect(results.every((r) => r.status === 'SUCCEEDED')).toBe(true);
  });
});
