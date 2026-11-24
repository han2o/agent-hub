import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentHubError,
  extractRepoName,
  normalizeGitOriginUrl,
  rewritePath,
  sanitizeBranchSegment,
  type GitWipResult,
  type PathMappingRule,
  type RepoInfo,
  type RepoMappingEntry,
  type TargetWorkspacePrepResult
} from '@agent-hub/protocol';

const execFileAsync = promisify(execFile);

async function runGit(
  args: string[],
  cwd?: string,
  timeout = 120000
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function tryGit(
  args: string[],
  cwd?: string,
  timeout = 15000
): Promise<string | null> {
  try {
    const { stdout } = await runGit(args, cwd, timeout);
    return stdout.trim();
  } catch {
    return null;
  }
}

export class GitWorkspaceEngine {
  async inspectRepo(dirPath: string): Promise<RepoInfo & { repoRoot: string | null; subPath: string }> {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return {
        path: dirPath,
        name: path.basename(dirPath || 'unknown'),
        isGit: false,
        originUrl: null,
        normalizedOrigin: null,
        branch: null,
        headSha: null,
        isDirty: false,
        dirtyFilesCount: 0,
        repoRoot: null,
        subPath: ''
      };
    }

    const repoRoot = await tryGit(['rev-parse', '--show-toplevel'], dirPath);
    if (!repoRoot) {
      return {
        path: dirPath,
        name: path.basename(dirPath),
        isGit: false,
        originUrl: null,
        normalizedOrigin: null,
        branch: null,
        headSha: null,
        isDirty: false,
        dirtyFilesCount: 0,
        repoRoot: null,
        subPath: ''
      };
    }

    const originUrl = await tryGit(['remote', 'get-url', 'origin'], repoRoot);
    const normalizedOrigin = originUrl ? normalizeGitOriginUrl(originUrl) : null;
    const symBranch = await tryGit(['symbolic-ref', '--short', 'HEAD'], repoRoot);
    const headSha = await tryGit(['rev-parse', 'HEAD'], repoRoot);
    const branch = symBranch ?? (headSha ? 'detached' : 'main');
    const porcelain = await tryGit(['status', '--porcelain'], repoRoot);
    const dirtyLines = porcelain
      ? porcelain.split(/\r?\n/).filter((l) => l.trim().length > 0)
      : [];

    const resolvedDir = fs.realpathSync(dirPath);
    const resolvedRoot = fs.realpathSync(repoRoot);
    const subPath = path.relative(resolvedRoot, resolvedDir);

    return {
      path: resolvedRoot,
      name: path.basename(resolvedRoot),
      isGit: true,
      originUrl,
      normalizedOrigin,
      branch,
      headSha,
      isDirty: dirtyLines.length > 0,
      dirtyFilesCount: dirtyLines.length,
      repoRoot: resolvedRoot,
      subPath: subPath && !subPath.startsWith('..') ? subPath : ''
    };
  }

  async listReposInRoots(roots: string[], maxDepth = 3): Promise<RepoInfo[]> {
    const seenRoots = new Set<string>();
    const results: RepoInfo[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || !fs.existsSync(dir)) return;
      const gitMarker = path.join(dir, '.git');
      if (fs.existsSync(gitMarker)) {
        const info = await this.inspectRepo(dir);
        if (info.isGit && info.repoRoot && !seenRoots.has(info.repoRoot)) {
          seenRoots.add(info.repoRoot);
          results.push({
            path: info.path,
            name: info.name,
            isGit: info.isGit,
            originUrl: info.originUrl,
            normalizedOrigin: info.normalizedOrigin,
            branch: info.branch,
            headSha: info.headSha,
            isDirty: info.isDirty,
            dirtyFilesCount: info.dirtyFilesCount
          });
        }
        return;
      }

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'target'
        ) {
          continue;
        }
        await walk(path.join(dir, entry.name), depth + 1);
      }
    };

    for (const root of roots) {
      await walk(root, 0);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async findRepoByOrigin(
    roots: string[],
    normalizedOrigin: string
  ): Promise<RepoInfo | null> {
    if (!normalizedOrigin) return null;
    const repos = await this.listReposInRoots(roots, 3);
    return repos.find((r) => r.normalizedOrigin === normalizedOrigin) ?? null;
  }

  private async ensureGitCommitIdentity(repoRoot: string): Promise<string[]> {
    const name = await tryGit(['config', 'user.name'], repoRoot);
    const email = await tryGit(['config', 'user.email'], repoRoot);
    const args: string[] = [];
    if (!name) args.push('-c', 'user.name=Agent Hub');
    if (!email) args.push('-c', 'user.email=agent-hub@local');
    return args;
  }

  async createAndPushWipBranch(opts: {
    cwd: string;
    sessionId: string;
    wipBranchPrefix?: string;
    skipGitPush?: boolean;
  }): Promise<GitWipResult & { subPath: string }> {
    const logs: string[] = [];
    const info = await this.inspectRepo(opts.cwd);

    if (!info.isGit || !info.repoRoot) {
      logs.push(`Directory ${opts.cwd} is not a git repo; skipping git sync.`);
      return {
        isGit: false,
        originUrl: null,
        normalizedOrigin: null,
        origBranch: null,
        wipBranch: null,
        commitSha: null,
        pushed: false,
        message: 'Non-git workspace; session files only',
        logs,
        subPath: ''
      };
    }

    const repoRoot = info.repoRoot;
    if (!info.originUrl && !opts.skipGitPush) {
      throw new AgentHubError(
        'GIT_SYNC_FAILED',
        `Git repository ${repoRoot} has no 'origin' remote configured`,
        400
      );
    }

    const prefix = (opts.wipBranchPrefix || 'wip/handoff').replace(/\/+$/, '');
    const shortId = opts.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'handoff';
    const safeBranch = sanitizeBranchSegment(info.branch || 'detached');
    const wipBranch = `${prefix}/${safeBranch}/${shortId}`;

    try {
      await runGit(['checkout', '-B', wipBranch], repoRoot);
      logs.push(`Checked out WIP branch ${wipBranch}`);

      if (info.isDirty || !info.headSha) {
        await runGit(['add', '-A'], repoRoot);
        const statusAfterAdd = await tryGit(['status', '--porcelain'], repoRoot);
        if (statusAfterAdd || !info.headSha) {
          const identityArgs = await this.ensureGitCommitIdentity(repoRoot);
          const commitArgs = [
            ...identityArgs,
            'commit',
            '--no-verify',
            ...(statusAfterAdd ? [] : ['--allow-empty']),
            '-m',
            `wip(agent-hub): handoff ${opts.sessionId} from mac to mini`
          ];
          const res = await runGit(commitArgs, repoRoot);
          logs.push(res.stdout.trim() || 'Created WIP commit');
        }
      }

      const commitSha = await tryGit(['rev-parse', 'HEAD'], repoRoot);
      if (!commitSha) {
        throw new Error('Unable to resolve HEAD commit SHA after WIP commit');
      }

      let pushed = false;
      if (!opts.skipGitPush && info.originUrl) {
        const pushRes = await runGit(
          ['push', '--force-with-lease', '-u', 'origin', wipBranch],
          repoRoot
        );
        pushed = true;
        logs.push(pushRes.stderr.trim() || pushRes.stdout.trim() || `Pushed ${wipBranch} to origin`);
      }

      return {
        isGit: true,
        originUrl: info.originUrl,
        normalizedOrigin: info.normalizedOrigin,
        origBranch: info.branch,
        wipBranch,
        commitSha,
        pushed,
        message: pushed
          ? `Synced WIP branch ${wipBranch} (${commitSha.slice(0, 7)}) to origin`
          : `Prepared local WIP branch ${wipBranch} (${commitSha.slice(0, 7)})`,
        logs,
        subPath: info.subPath
      };
    } catch (err) {
      if (err instanceof AgentHubError) throw err;
      throw new AgentHubError(
        'GIT_SYNC_FAILED',
        `Git WIP sync failed in ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`,
        500,
        { logs }
      );
    }
  }

  async prepareTargetWorkspace(opts: {
    sessionId: string;
    isGit: boolean;
    originUrl: string | null;
    normalizedOrigin: string | null;
    wipBranch: string | null;
    commitSha: string | null;
    sourceCwd: string;
    sourceHome: string;
    targetHome: string;
    sourceWorkspaceRoots: string[];
    targetWorkspaceRoots: string[];
    worktreesRoot: string;
    repoMappings: RepoMappingEntry[];
    occupiedCwds: string[];
    subPath?: string;
    forceWorktree?: boolean;
  }): Promise<TargetWorkspacePrepResult> {
    const logs: string[] = [];

    const mappingRule: PathMappingRule = {
      sourceHome: opts.sourceHome,
      targetHome: opts.targetHome,
      sourceCwd: opts.sourceCwd,
      targetCwd: opts.sourceCwd,
      sourceWorkspaceRoots: opts.sourceWorkspaceRoots,
      targetWorkspaceRoots: opts.targetWorkspaceRoots,
      repoMappings: opts.repoMappings
    };

    if (!opts.isGit) {
      // Non-git: map path heuristically and ensure directory exists
      const mappedRule: PathMappingRule = {
        ...mappingRule,
        sourceCwd: '__never_match__',
        targetCwd: '__never_match__'
      };
      const candidate = rewritePath(opts.sourceCwd, mappedRule);
      const targetCwd =
        candidate !== opts.sourceCwd
          ? candidate
          : path.join(opts.targetHome, 'Workspace', path.basename(opts.sourceCwd) || 'handoff');
      fs.mkdirSync(targetCwd, { recursive: true });
      logs.push(`Non-git workspace mapped to ${targetCwd}`);
      return {
        targetCwd,
        isGit: false,
        worktreeCreated: false,
        checkedOutBranch: null,
        commitSha: null,
        logs
      };
    }

    // 1. Check explicit repoMappings first
    let repoDir: string | null = null;
    for (const entry of opts.repoMappings) {
      const normEntrySrc = path.posix.normalize(entry.sourceCwd).replace(/\/+$/, '');
      const normSource = path.posix.normalize(opts.sourceCwd).replace(/\/+$/, '');
      if (normSource === normEntrySrc || normSource.startsWith(`${normEntrySrc}/`)) {
        if (fs.existsSync(entry.targetCwd)) {
          const info = await this.inspectRepo(entry.targetCwd);
          if (
            !opts.normalizedOrigin ||
            !info.normalizedOrigin ||
            info.normalizedOrigin === opts.normalizedOrigin
          ) {
            repoDir = info.repoRoot ?? entry.targetCwd;
            logs.push(`Matched explicit repo mapping -> ${repoDir}`);
            break;
          }
        }
      }
    }

    // 2. Match by normalized Git origin URL across targetWorkspaceRoots
    if (!repoDir && opts.normalizedOrigin) {
      const found = await this.findRepoByOrigin(
        opts.targetWorkspaceRoots,
        opts.normalizedOrigin
      );
      if (found) {
        repoDir = found.path;
        logs.push(`Matched Mini repo by git origin (${opts.normalizedOrigin}) -> ${repoDir}`);
      }
    }

    // 3. Auto-clone if absent
    if (!repoDir) {
      if (!opts.originUrl) {
        throw new AgentHubError(
          'GIT_SYNC_FAILED',
          'Cannot auto-clone on target node: missing originUrl',
          400
        );
      }
      const defaultRoot =
        opts.targetWorkspaceRoots[0] || path.join(opts.targetHome, 'Workspace');
      fs.mkdirSync(defaultRoot, { recursive: true });
      const repoName = extractRepoName(opts.originUrl || opts.sourceCwd);
      let cloneDest = path.join(defaultRoot, repoName);
      if (fs.existsSync(cloneDest)) {
        cloneDest = path.join(
          defaultRoot,
          `${repoName}-${opts.sessionId.slice(0, 6)}`
        );
      }
      logs.push(`Cloning ${opts.originUrl} -> ${cloneDest}`);
      try {
        await runGit(['clone', opts.originUrl, cloneDest]);
      } catch (err) {
        throw new AgentHubError(
          'GIT_SYNC_FAILED',
          `Auto-clone failed for ${opts.originUrl}: ${err instanceof Error ? err.message : String(err)}`,
          500,
          { logs }
        );
      }
      repoDir = cloneDest;
    }

    const targetRepoInfo = await this.inspectRepo(repoDir);
    const resolvedRepoDir = targetRepoInfo.repoRoot ?? repoDir;

    try {
      if (opts.wipBranch) {
        await runGit(['fetch', 'origin', opts.wipBranch], resolvedRepoDir);
      } else {
        await runGit(['fetch', 'origin'], resolvedRepoDir);
      }
    } catch (err) {
      throw new AgentHubError(
        'GIT_SYNC_FAILED',
        `Git fetch failed in ${resolvedRepoDir}: ${err instanceof Error ? err.message : String(err)}`,
        500,
        { logs }
      );
    }

    const targetRef = opts.wipBranch
      ? `origin/${opts.wipBranch}`
      : opts.commitSha || 'HEAD';

    const normOccupied = new Set(
      opts.occupiedCwds.map((c) => path.posix.normalize(c).replace(/\/+$/, ''))
    );
    const isOccupied =
      normOccupied.has(path.posix.normalize(resolvedRepoDir).replace(/\/+$/, '')) ||
      Array.from(normOccupied).some((c) => c.startsWith(`${resolvedRepoDir}/`));

    const needWorktree = Boolean(
      opts.forceWorktree || targetRepoInfo.isDirty || isOccupied
    );

    let finalRepoDir = resolvedRepoDir;
    let worktreeCreated = false;
    let checkedOutBranch = opts.wipBranch;

    if (needWorktree) {
      const shortId = opts.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'wt';
      fs.mkdirSync(opts.worktreesRoot, { recursive: true });
      let wtPath = path.join(
        opts.worktreesRoot,
        `${extractRepoName(resolvedRepoDir)}-${shortId}`
      );
      if (fs.existsSync(wtPath)) {
        wtPath = path.join(
          opts.worktreesRoot,
          `${extractRepoName(resolvedRepoDir)}-${shortId}-${Date.now().toString(36)}`
        );
      }
      const localWtBranch = `handoff/${shortId}-${Date.now().toString(36).slice(-4)}`;
      logs.push(
        `Target repo ${resolvedRepoDir} is ${targetRepoInfo.isDirty ? 'dirty' : 'occupied'}; creating isolated worktree at ${wtPath}`
      );
      try {
        await runGit(['worktree', 'prune'], resolvedRepoDir);
        await runGit(
          ['worktree', 'add', '-B', localWtBranch, wtPath, targetRef],
          resolvedRepoDir
        );
      } catch (err) {
        throw new AgentHubError(
          'GIT_SYNC_FAILED',
          `Failed to create git worktree at ${wtPath}: ${err instanceof Error ? err.message : String(err)}`,
          500,
          { logs }
        );
      }
      finalRepoDir = wtPath;
      worktreeCreated = true;
      checkedOutBranch = localWtBranch;
    } else if (opts.wipBranch) {
      try {
        await runGit(
          ['checkout', '-B', opts.wipBranch, targetRef],
          resolvedRepoDir
        );
        logs.push(`Checked out ${opts.wipBranch} in ${resolvedRepoDir}`);
      } catch (err) {
        throw new AgentHubError(
          'GIT_SYNC_FAILED',
          `Failed to checkout ${opts.wipBranch} in ${resolvedRepoDir}: ${err instanceof Error ? err.message : String(err)}`,
          500,
          { logs }
        );
      }
    }

    const verifiedSha = await tryGit(['rev-parse', 'HEAD'], finalRepoDir);
    if (opts.commitSha && verifiedSha && verifiedSha !== opts.commitSha) {
      logs.push(
        `Warning: checked out SHA ${verifiedSha} differs from source ${opts.commitSha}`
      );
    }

    const subTarget =
      opts.subPath && opts.subPath.trim()
        ? path.join(finalRepoDir, opts.subPath)
        : finalRepoDir;
    const finalCwd = fs.existsSync(subTarget) ? subTarget : finalRepoDir;

    return {
      targetCwd: finalCwd,
      isGit: true,
      worktreeCreated,
      checkedOutBranch,
      commitSha: verifiedSha ?? opts.commitSha,
      logs
    };
  }
}
