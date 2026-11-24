import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorkspaceEngine } from '@agent-hub/runtime';

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

describe('GitWorkspaceEngine WIP push & Mini worktree isolation', () => {
  let tmpRoot: string;
  let bareOrigin: string;
  let macRepo: string;
  let miniRoot: string;
  let miniRepo: string;
  let worktreesRoot: string;
  const engine = new GitWorkspaceEngine();

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-git-test-')));
    bareOrigin = path.join(tmpRoot, 'origin.git');
    const seedDir = path.join(tmpRoot, 'seed');
    const macRoot = path.join(tmpRoot, 'mac-home', 'Workspace');
    miniRoot = path.join(tmpRoot, 'mini-home', 'Projects');
    worktreesRoot = path.join(tmpRoot, 'mini-home', '.agent-hub', 'worktrees');

    fs.mkdirSync(bareOrigin, { recursive: true });
    fs.mkdirSync(macRoot, { recursive: true });
    fs.mkdirSync(miniRoot, { recursive: true });

    git(['init', '--bare', bareOrigin]);
    git(['clone', bareOrigin, seedDir]);
    git(['checkout', '-b', 'main'], seedDir);
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'initial\n', 'utf8');
    git(['add', 'README.md'], seedDir);
    git(['commit', '-m', 'init'], seedDir);
    git(['push', '-u', 'origin', 'main'], seedDir);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bareOrigin);

    macRepo = path.join(macRoot, 'my-service');
    miniRepo = path.join(miniRoot, 'service-mini-alias');
    git(['clone', bareOrigin, macRepo]);
    git(['clone', bareOrigin, miniRepo]);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('commits & pushes dirty Mac edits to WIP branch and checks out on clean Mini repo matched by origin', async () => {
    fs.writeFileSync(path.join(macRepo, 'README.md'), 'updated by mac\n', 'utf8');
    fs.writeFileSync(path.join(macRepo, 'new-file.ts'), 'export const ok = 1;\n', 'utf8');

    const wip = await engine.createAndPushWipBranch({
      cwd: macRepo,
      sessionId: 'sess1234-5678',
      wipBranchPrefix: 'wip/handoff'
    });
    expect(wip.isGit).toBe(true);
    expect(wip.pushed).toBe(true);
    expect(wip.wipBranch).toBe('wip/handoff/main/sess1234');
    expect(wip.commitSha).toBeTruthy();

    const prep = await engine.prepareTargetWorkspace({
      sessionId: 'sess1234-5678',
      isGit: wip.isGit,
      originUrl: wip.originUrl,
      normalizedOrigin: wip.normalizedOrigin,
      wipBranch: wip.wipBranch,
      commitSha: wip.commitSha,
      sourceCwd: macRepo,
      sourceHome: path.join(tmpRoot, 'mac-home'),
      targetHome: path.join(tmpRoot, 'mini-home'),
      sourceWorkspaceRoots: [path.dirname(macRepo)],
      targetWorkspaceRoots: [miniRoot],
      worktreesRoot,
      repoMappings: [],
      occupiedCwds: []
    });

    expect(prep.worktreeCreated).toBe(false);
    expect(fs.realpathSync(prep.targetCwd)).toBe(fs.realpathSync(miniRepo));
    expect(prep.commitSha).toBe(wip.commitSha);
    expect(fs.readFileSync(path.join(prep.targetCwd, 'README.md'), 'utf8')).toBe(
      'updated by mac\n'
    );
    expect(fs.readFileSync(path.join(prep.targetCwd, 'new-file.ts'), 'utf8')).toBe(
      'export const ok = 1;\n'
    );
  });

  it('automatically isolates with git worktree when Mini repo has uncommitted local changes', async () => {
    // Dirty Mini repo
    fs.writeFileSync(path.join(miniRepo, 'mini-local.txt'), 'do not overwrite me!\n', 'utf8');

    // Dirty Mac repo
    fs.writeFileSync(path.join(macRepo, 'README.md'), 'from mac handoff\n', 'utf8');

    const wip = await engine.createAndPushWipBranch({
      cwd: macRepo,
      sessionId: 'dirtymini-99',
      wipBranchPrefix: 'wip/handoff'
    });

    const prep = await engine.prepareTargetWorkspace({
      sessionId: 'dirtymini-99',
      isGit: wip.isGit,
      originUrl: wip.originUrl,
      normalizedOrigin: wip.normalizedOrigin,
      wipBranch: wip.wipBranch,
      commitSha: wip.commitSha,
      sourceCwd: macRepo,
      sourceHome: path.join(tmpRoot, 'mac-home'),
      targetHome: path.join(tmpRoot, 'mini-home'),
      sourceWorkspaceRoots: [path.dirname(macRepo)],
      targetWorkspaceRoots: [miniRoot],
      worktreesRoot,
      repoMappings: [],
      occupiedCwds: []
    });

    expect(prep.worktreeCreated).toBe(true);
    expect(prep.targetCwd).toContain(worktreesRoot);
    expect(fs.readFileSync(path.join(prep.targetCwd, 'README.md'), 'utf8')).toBe(
      'from mac handoff\n'
    );
    // Mini's own uncommitted file remains 100% untouched!
    expect(fs.readFileSync(path.join(miniRepo, 'mini-local.txt'), 'utf8')).toBe(
      'do not overwrite me!\n'
    );
    expect(fs.readFileSync(path.join(miniRepo, 'README.md'), 'utf8')).toBe('initial\n');
  });

  it('auto-clones from origin when repo is missing on Mini', async () => {
    const emptyMiniRoot = path.join(tmpRoot, 'empty-mini-ws');
    fs.mkdirSync(emptyMiniRoot, { recursive: true });
    fs.writeFileSync(path.join(macRepo, 'README.md'), 'cloned to mini\n', 'utf8');

    const wip = await engine.createAndPushWipBranch({
      cwd: macRepo,
      sessionId: 'autoclone-01'
    });

    const prep = await engine.prepareTargetWorkspace({
      sessionId: 'autoclone-01',
      isGit: wip.isGit,
      originUrl: wip.originUrl,
      normalizedOrigin: wip.normalizedOrigin,
      wipBranch: wip.wipBranch,
      commitSha: wip.commitSha,
      sourceCwd: macRepo,
      sourceHome: path.join(tmpRoot, 'mac-home'),
      targetHome: path.join(tmpRoot, 'mini-home'),
      sourceWorkspaceRoots: [path.dirname(macRepo)],
      targetWorkspaceRoots: [emptyMiniRoot],
      worktreesRoot,
      repoMappings: [],
      occupiedCwds: []
    });

    expect(prep.targetCwd.startsWith(emptyMiniRoot)).toBe(true);
    expect(fs.readFileSync(path.join(prep.targetCwd, 'README.md'), 'utf8')).toBe(
      'cloned to mini\n'
    );
  });
});
