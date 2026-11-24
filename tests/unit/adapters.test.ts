import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgyAdapter,
  ClaudeAdapter,
  PiAdapter,
  QoderAdapter
} from '@agent-hub/adapters';
import {
  encodeClaudeCwd,
  encodePiSessionDirName,
  encodeQoderCwd,
  type PathMappingRule
} from '@agent-hub/protocol';

describe('4 Agent Adapters bundle export/import round-trips', () => {
  let tmpRoot: string;
  let macHome: string;
  let miniHome: string;
  let macDataDir: string;
  let miniDataDir: string;
  let macCwd: string;
  let miniCwd: string;
  let rule: PathMappingRule;
  const chmodRestoreList: string[] = [];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-adapters-test-'));
    macHome = path.join(tmpRoot, 'mac-home');
    miniHome = path.join(tmpRoot, 'mini-home');
    macDataDir = path.join(macHome, '.agent-hub');
    miniDataDir = path.join(miniHome, '.agent-hub');
    macCwd = path.join(macHome, 'Workspace', 'my-app');
    miniCwd = path.join(miniHome, 'Projects', 'my-app-renamed');
    fs.mkdirSync(macCwd, { recursive: true });
    fs.mkdirSync(miniCwd, { recursive: true });

    rule = {
      sourceHome: macHome,
      targetHome: miniHome,
      sourceCwd: macCwd,
      targetCwd: miniCwd,
      sourceWorkspaceRoots: [path.join(macHome, 'Workspace')],
      targetWorkspaceRoots: [path.join(miniHome, 'Projects')],
      repoMappings: []
    };
  });

  afterEach(() => {
    for (const f of chmodRestoreList.splice(0)) {
      try {
        fs.chmodSync(f, 0o644);
      } catch {
        // ignore
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('PiAdapter discovers, exports, and imports with rewritten cwd', async () => {
    const sessionId = '01a1eddf-2d7c-7673-b938-302855d1048c';
    const srcDir = path.join(
      macHome,
      '.pi',
      'agent',
      'sessions',
      encodePiSessionDirName(macCwd)
    );
    fs.mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, `2026-11-24T10-00-00-000Z_${sessionId}.jsonl`);
    fs.writeFileSync(
      srcFile,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: sessionId,
          timestamp: '2026-11-24T10:00:00.000Z',
          cwd: macCwd
        }),
        JSON.stringify({
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'Implement handoff' }]
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const srcPi = new PiAdapter({ homeDir: macHome, dataDir: macDataDir });
    const dstPi = new PiAdapter({ homeDir: miniHome, dataDir: miniDataDir });

    const discovered = await srcPi.discoverSessions(20);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].externalSessionId).toBe(sessionId);
    expect(discovered[0].cwd).toBe(macCwd);

    const staging = path.join(tmpRoot, 'staging-pi');
    const manifest = await srcPi.exportBundle(
      { externalSessionId: sessionId, cwd: macCwd, title: 'Implement handoff' },
      staging
    );
    const imported = await dstPi.importBundle(manifest, staging, rule);
    expect(imported.targetSessionFilePath).toBeTruthy();
    expect(fs.existsSync(imported.targetSessionFilePath!)).toBe(true);

    const importedLines = fs
      .readFileSync(imported.targetSessionFilePath!, 'utf8')
      .trim()
      .split('\n');
    const header = JSON.parse(importedLines[0]) as { cwd: string; id: string };
    expect(header.id).toBe(sessionId);
    expect(header.cwd).toBe(miniCwd);
    expect(imported.targetSessionFilePath!).toContain(encodePiSessionDirName(miniCwd));
  });

  it('ClaudeAdapter exports/imports JSONL + sibling subagent directory', async () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const srcDir = path.join(macHome, '.claude', 'projects', encodeClaudeCwd(macCwd));
    const siblingDir = path.join(srcDir, sessionId);
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'subagent.json'), '{"ok":true}', 'utf8');

    const srcFile = path.join(srcDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      srcFile,
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd: macCwd,
          message: { role: 'user', content: 'Fix auth token' }
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd: path.join(macCwd, 'packages'),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Working...' }] }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const srcClaude = new ClaudeAdapter({ homeDir: macHome, dataDir: macDataDir });
    const dstClaude = new ClaudeAdapter({ homeDir: miniHome, dataDir: miniDataDir });

    const staging = path.join(tmpRoot, 'staging-claude');
    const manifest = await srcClaude.exportBundle(
      { externalSessionId: sessionId, cwd: macCwd },
      staging
    );
    const imported = await dstClaude.importBundle(manifest, staging, rule);
    const destLines = fs
      .readFileSync(imported.targetSessionFilePath!, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { cwd: string });

    expect(destLines[0].cwd).toBe(miniCwd);
    expect(destLines[1].cwd).toBe(path.join(miniCwd, 'packages'));
    const destSibling = path.join(
      miniHome,
      '.claude',
      'projects',
      encodeClaudeCwd(miniCwd),
      sessionId,
      'subagent.json'
    );
    expect(fs.existsSync(destSibling)).toBe(true);
  });

  it('QoderAdapter skips unreadable files gracefully and migrates readable transcripts', async () => {
    const goodId = 'aaaa1111-bbbb-2222-cccc-333333333333';
    const lockedId = 'deadbeef-0000-0000-0000-000000000000';
    const transcriptDir = path.join(
      macHome,
      '.qoder',
      'projects',
      encodeQoderCwd(macCwd),
      'transcript'
    );
    fs.mkdirSync(transcriptDir, { recursive: true });

    const goodFile = path.join(transcriptDir, `${goodId}.jsonl`);
    fs.writeFileSync(
      goodFile,
      JSON.stringify({
        role: 'user',
        cwd: macCwd,
        content: 'Refactor service layer'
      }) + '\n',
      'utf8'
    );

    const lockedFile = path.join(transcriptDir, `${lockedId}.jsonl`);
    fs.writeFileSync(lockedFile, '{"role":"user"}\n', 'utf8');
    fs.chmodSync(lockedFile, 0o000);
    chmodRestoreList.push(lockedFile);

    const srcQoder = new QoderAdapter({ homeDir: macHome, dataDir: macDataDir });
    const dstQoder = new QoderAdapter({ homeDir: miniHome, dataDir: miniDataDir });

    const discovered = await srcQoder.discoverSessions(20);
    // Should not throw on locked file, and should find the readable one
    expect(discovered.some((d) => d.externalSessionId === goodId)).toBe(true);

    const staging = path.join(tmpRoot, 'staging-qoder');
    const manifest = await srcQoder.exportBundle(
      { externalSessionId: goodId, cwd: macCwd },
      staging
    );
    const imported = await dstQoder.importBundle(manifest, staging, rule);
    const parsed = JSON.parse(
      fs.readFileSync(imported.targetSessionFilePath!, 'utf8').trim()
    ) as { cwd: string };
    expect(parsed.cwd).toBe(miniCwd);
    expect(imported.targetSessionFilePath!).toContain(encodeQoderCwd(miniCwd));
  });

  it('AgyAdapter safely backs up WAL sqlite DB, merges summary row, and creates fallback_context.md', async () => {
    const convId = '981bd2b2-2138-4095-a524-7dd783ae22a7';
    const agyRoot = path.join(macHome, '.gemini', 'antigravity');
    const convsDir = path.join(agyRoot, 'conversations');
    const brainDir = path.join(agyRoot, 'brain', convId);
    const logsDir = path.join(brainDir, '.system_generated', 'logs');
    fs.mkdirSync(convsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // Create WAL-mode conversation DB
    const convDbPath = path.join(convsDir, `${convId}.db`);
    const convDb = new DatabaseSync(convDbPath);
    convDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, metadata BLOB);
      INSERT INTO steps (idx, step_type, metadata) VALUES (0, 1, X'DEADBEEF');
    `);
    convDb.close();

    // Create brain artifacts & transcript
    fs.writeFileSync(path.join(brainDir, 'task.md'), '# Task\n- [x] Step 1\n', 'utf8');
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      JSON.stringify({
        type: 'USER_INPUT',
        created_at: '2026-11-24T10:00:00Z',
        content: 'Build Agent Hub'
      }) + '\n',
      'utf8'
    );

    // Create conversation_summaries.db
    const summariesDbPath = path.join(agyRoot, 'conversation_summaries.db');
    const sumDb = new DatabaseSync(summariesDbPath);
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        preview text NOT NULL DEFAULT '',
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        status text NOT NULL DEFAULT '',
        source text NOT NULL DEFAULT '',
        project_id text NOT NULL DEFAULT '',
        agent_name text NOT NULL DEFAULT '',
        parent_conversation_id text NOT NULL DEFAULT '',
        nesting_depth integer NOT NULL DEFAULT 0,
        battle_id text NOT NULL DEFAULT '',
        winning_conversation_id text NOT NULL DEFAULT '',
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL,
        last_user_input_step_index integer NOT NULL DEFAULT -1,
        app_data_dir text NOT NULL DEFAULT '',
        raw_summary blob,
        group_id text NOT NULL DEFAULT ''
      );
    `);
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, not_fully_idle, last_user_input_time,
          app_data_dir, raw_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        convId,
        'Build Agent Hub',
        'Working on Step 1',
        7,
        '2026-11-24T10:05:00Z',
        JSON.stringify([`file://${macCwd}`]),
        'CASCADE_RUN_STATUS_RUNNING',
        1,
        '2026-11-24T10:00:00Z',
        'antigravity',
        Buffer.from([1, 2, 3, 4])
      );
    sumDb.close();

    const srcAgy = new AgyAdapter({ homeDir: macHome, dataDir: macDataDir });
    const dstAgy = new AgyAdapter({ homeDir: miniHome, dataDir: miniDataDir });

    const discovered = await srcAgy.discoverSessions(10);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].stateHint).toBe('RUNNING');
    expect(discovered[0].cwd).toBe(macCwd);

    const staging = path.join(tmpRoot, 'staging-agy');
    const manifest = await srcAgy.exportBundle(
      { externalSessionId: convId, cwd: macCwd },
      staging
    );
    const imported = await dstAgy.importBundle(manifest, staging, rule);

    expect(imported.targetSessionFilePath).toBeTruthy();
    expect(fs.existsSync(imported.targetSessionFilePath!)).toBe(true);
    expect(imported.fallbackContextFile).toBeTruthy();
    expect(fs.existsSync(imported.fallbackContextFile!)).toBe(true);

    // Verify backed up conversation DB contents
    const verifyConv = new DatabaseSync(imported.targetSessionFilePath!, { readOnly: true });
    const stepRow = verifyConv.prepare('SELECT idx, step_type FROM steps').get() as {
      idx: number;
      step_type: number;
    };
    expect(stepRow.idx).toBe(0);
    expect(stepRow.step_type).toBe(1);
    verifyConv.close();

    // Verify rewritten workspace_uris & blob preservation in Mini summaries DB
    const miniSummaries = new DatabaseSync(
      path.join(miniHome, '.gemini', 'antigravity', 'conversation_summaries.db'),
      { readOnly: true }
    );
    const sumRow = miniSummaries
      .prepare('SELECT title, workspace_uris, raw_summary FROM conversation_summaries WHERE conversation_id = ?')
      .get(convId) as { title: string; workspace_uris: string; raw_summary: Uint8Array };
    expect(sumRow.title).toBe('Build Agent Hub');
    expect(JSON.parse(sumRow.workspace_uris)).toEqual([`file://${miniCwd}`]);
    expect(Buffer.from(sumRow.raw_summary)).toEqual(Buffer.from([1, 2, 3, 4]));
    miniSummaries.close();

    // Verify brain artifact & fallback context copied
    expect(
      fs.existsSync(
        path.join(miniHome, '.gemini', 'antigravity', 'brain', convId, 'task.md')
      )
    ).toBe(true);
    const fallbackText = fs.readFileSync(imported.fallbackContextFile!, 'utf8');
    expect(fallbackText).toContain('Build Agent Hub');
  });
});
