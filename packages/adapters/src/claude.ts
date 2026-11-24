import fs from 'node:fs';
import path from 'node:path';
import {
  AgentHubError,
  encodeClaudeCwd,
  type AgentProbeResult,
  type DiscoveredSession,
  type ImportBundleResult,
  type PathMappingRule,
  type ProgressEventItem,
  type ProgressSnapshot,
  type ResumeSessionRequest,
  type SessionBundleManifest,
  type SessionRecord,
  type StartSessionRequest
} from '@agent-hub/protocol';
import {
  buildShellInvocation,
  copyDirectoryRecursive,
  extractTextContent,
  findBinary,
  getBinaryVersion,
  inferStateFromEventsAndPty,
  mapPermissionFlags,
  readJsonlLines,
  rewriteJsonlCwdLines,
  type AdapterOptions,
  type AgentAdapter,
  type CommandInvocation
} from './base.js';

export class ClaudeAdapter implements AgentAdapter {
  public readonly kind = 'claude' as const;
  private readonly opts: AdapterOptions;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  private getProjectsRoot(): string {
    return path.join(this.opts.homeDir, '.claude', 'projects');
  }

  async probe(): Promise<AgentProbeResult> {
    const binaryPath = await findBinary('claude', this.opts.config?.binary, this.opts.homeDir);
    const version = binaryPath ? await getBinaryVersion(binaryPath) : null;
    const sessionDir = this.getProjectsRoot();
    let sessionDirReadable = false;
    try {
      if (fs.existsSync(sessionDir)) {
        fs.accessSync(sessionDir, fs.constants.R_OK);
        sessionDirReadable = true;
      }
    } catch {
      sessionDirReadable = false;
    }
    return {
      kind: 'claude',
      installed: Boolean(binaryPath),
      binaryPath,
      version,
      sessionDir,
      sessionDirReadable,
      notes: !binaryPath ? 'claude binary not found in PATH or standard locations' : undefined
    };
  }

  private parseClaudeFile(filePath: string): DiscoveredSession | null {
    try {
      const stat = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) return null;

      let externalSessionId = path.basename(filePath, '.jsonl');
      let cwd = '';
      let title = '';
      let preview = '';
      let stepCount = 0;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (typeof obj.sessionId === 'string') externalSessionId = obj.sessionId;
          if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
          const type = String(obj.type ?? '');
          const msgObj = (obj.message as Record<string, unknown> | undefined) ?? obj;
          const text = extractTextContent(msgObj.content ?? obj.content ?? '');
          if (type === 'user' || type === 'assistant') {
            stepCount++;
            if (!title && type === 'user' && text) title = text.slice(0, 80);
            if (text) preview = text.slice(0, 140);
          }
        } catch {
          // ignore malformed line
        }
      }

      return {
        agent: 'claude',
        externalSessionId,
        title: title || path.basename(cwd || filePath),
        preview: preview || '(empty claude session)',
        cwd,
        filePath,
        stateHint: Date.now() - stat.mtimeMs < 5000 ? 'RUNNING' : 'IDLE',
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        stepCount
      };
    } catch {
      return null;
    }
  }

  async discoverSessions(limit = 50): Promise<DiscoveredSession[]> {
    const root = this.getProjectsRoot();
    if (!fs.existsSync(root)) return [];

    const results: DiscoveredSession[] = [];
    for (const dirEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      const subDir = path.join(root, dirEntry.name);
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(subDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (entry.name.startsWith('agent-')) continue;
        const parsed = this.parseClaudeFile(path.join(subDir, entry.name));
        if (parsed) results.push(parsed);
      }
    }

    return results
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async findLatestSessionForCwd(
    cwd: string,
    sinceMs = 0
  ): Promise<DiscoveredSession | null> {
    const projectDir = path.join(this.getProjectsRoot(), encodeClaudeCwd(cwd));
    if (!fs.existsSync(projectDir)) return null;
    const candidates: DiscoveredSession[] = [];
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (entry.name.startsWith('agent-')) continue;
      const fullPath = path.join(projectDir, entry.name);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < sinceMs) continue;
      const parsed = this.parseClaudeFile(fullPath);
      if (parsed) candidates.push(parsed);
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0] ?? null;
  }

  buildStartCommand(req: StartSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'claude';
    const permArgs = mapPermissionFlags('claude', req.permissionMode ?? 'default');
    const args: string[] = [...(this.opts.config?.defaultArgs ?? []), ...permArgs];
    if (req.model) args.push('--model', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);
    if (req.initialPrompt) args.push(req.initialPrompt);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks ?? true,
        shellFunctionName: 'claude',
        hasExplicitBinary: Boolean(this.opts.config?.binary?.trim())
      })
    };
  }

  buildResumeCommand(req: ResumeSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'claude';
    const permArgs = mapPermissionFlags('claude', req.permissionMode ?? 'default');
    const args: string[] = [
      ...(this.opts.config?.defaultArgs ?? []),
      '--resume',
      req.externalSessionId,
      ...permArgs
    ];
    if (req.model) args.push('--model', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks ?? true,
        shellFunctionName: 'claude',
        hasExplicitBinary: Boolean(this.opts.config?.binary?.trim())
      })
    };
  }

  async observeProgress(
    session: SessionRecord,
    ptyTail: string,
    processAlive: boolean
  ): Promise<ProgressSnapshot> {
    let targetFile = session.sessionFilePath;
    if (!targetFile && session.externalSessionId) {
      const discovered = await this.discoverSessions(100);
      targetFile =
        discovered.find((d) => d.externalSessionId === session.externalSessionId)?.filePath ??
        null;
    }

    const events: ProgressEventItem[] = [];
    let mtimeMs = 0;
    let summary = session.latestSummary;

    if (targetFile && fs.existsSync(targetFile)) {
      const data = readJsonlLines(targetFile, 80);
      mtimeMs = data.mtimeMs;
      for (const obj of data.lines) {
        const type = String(obj.type ?? 'system');
        const msgObj = (obj.message as Record<string, unknown> | undefined) ?? obj;
        const ts =
          typeof obj.timestamp === 'string'
            ? obj.timestamp
            : new Date().toISOString();
        const text = extractTextContent(msgObj.content ?? obj.content ?? '');
        let kind: ProgressEventItem['kind'] = 'system';
        if (type === 'user') kind = 'user';
        else if (type === 'assistant') kind = 'assistant';
        if (
          Array.isArray(msgObj.content) &&
          msgObj.content.some(
            (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_use'
          )
        ) {
          kind = 'tool_call';
        } else if (
          Array.isArray(msgObj.content) &&
          msgObj.content.some(
            (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result'
          )
        ) {
          kind = 'tool_result';
        }
        if (text) {
          events.push({
            timestamp: ts,
            kind,
            title: type,
            detail: text.slice(0, 200)
          });
        }
      }
      if (events.length > 0) {
        summary = events[events.length - 1].detail;
      }
    }

    const inferred = inferStateFromEventsAndPty({
      events,
      fileMtimeMs: mtimeMs,
      ptyTail,
      processAlive,
      currentState: session.state
    });

    return {
      sessionId: session.id,
      state: inferred.state,
      summary: summary || session.title,
      approvalPrompt: inferred.approvalPrompt,
      stepCount: events.length,
      events: events.slice(-15),
      ptyTail,
      observedAt: new Date().toISOString()
    };
  }

  async exportBundle(
    session: {
      externalSessionId: string;
      sessionFilePath?: string | null;
      cwd: string;
      title?: string;
    },
    stagingDir: string
  ): Promise<SessionBundleManifest> {
    let sourceFile = session.sessionFilePath ?? null;
    if (!sourceFile || !fs.existsSync(sourceFile)) {
      const all = await this.discoverSessions(200);
      sourceFile =
        all.find((s) => s.externalSessionId === session.externalSessionId)?.filePath ?? null;
    }
    if (!sourceFile || !fs.existsSync(sourceFile)) {
      throw new AgentHubError(
        'BUNDLE_EXPORT_FAILED',
        `Claude session file not found for ${session.externalSessionId}`,
        404
      );
    }

    fs.mkdirSync(stagingDir, { recursive: true });
    const filename = path.basename(sourceFile);
    fs.copyFileSync(sourceFile, path.join(stagingDir, filename));
    const files = [filename];

    // Copy optional sibling directory `<uuid>/` if it exists (subagents/tool outputs)
    const siblingDir = path.join(
      path.dirname(sourceFile),
      session.externalSessionId
    );
    let hasSiblingDir = false;
    if (fs.existsSync(siblingDir) && fs.statSync(siblingDir).isDirectory()) {
      copyDirectoryRecursive(
        siblingDir,
        path.join(stagingDir, session.externalSessionId)
      );
      hasSiblingDir = true;
      files.push(session.externalSessionId);
    }

    const manifest: SessionBundleManifest = {
      version: 1,
      agent: 'claude',
      externalSessionId: session.externalSessionId,
      sourceHome: this.opts.homeDir,
      sourceCwd: session.cwd,
      title: session.title || filename,
      createdAt: new Date().toISOString(),
      files,
      metadata: {
        originalFilename: filename,
        hasSiblingDir
      }
    };
    fs.writeFileSync(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
    return manifest;
  }

  async importBundle(
    manifest: SessionBundleManifest,
    extractedDir: string,
    rule: PathMappingRule
  ): Promise<ImportBundleResult> {
    const filename =
      (manifest.metadata?.originalFilename as string | undefined) ||
      `${manifest.externalSessionId}.jsonl`;
    const srcFile = path.join(extractedDir, filename);
    if (!fs.existsSync(srcFile)) {
      throw new AgentHubError(
        'BUNDLE_IMPORT_FAILED',
        `Claude bundle file missing: ${filename}`,
        400
      );
    }

    const targetDir = path.join(
      this.getProjectsRoot(),
      encodeClaudeCwd(rule.targetCwd)
    );
    fs.mkdirSync(targetDir, { recursive: true });
    const destFile = path.join(targetDir, filename);

    const raw = fs.readFileSync(srcFile, 'utf8');
    const rewritten = rewriteJsonlCwdLines(raw, rule);
    fs.writeFileSync(destFile, rewritten, 'utf8');

    const srcSibling = path.join(extractedDir, manifest.externalSessionId);
    if (fs.existsSync(srcSibling) && fs.statSync(srcSibling).isDirectory()) {
      copyDirectoryRecursive(
        srcSibling,
        path.join(targetDir, manifest.externalSessionId)
      );
    }

    return {
      externalSessionId: manifest.externalSessionId,
      targetSessionFilePath: destFile,
      fallbackContextFile: null,
      warnings: []
    };
  }
}
