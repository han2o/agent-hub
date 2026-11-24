import fs from 'node:fs';
import path from 'node:path';
import {
  AgentHubError,
  encodeQoderCwd,
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
  extractTextContent,
  findBinary,
  getBinaryVersion,
  inferStateFromEventsAndPty,
  mapPermissionFlags,
  readFileSafe,
  readJsonlLines,
  rewriteJsonlCwdLines,
  type AdapterOptions,
  type AgentAdapter,
  type CommandInvocation
} from './base.js';

export class QoderAdapter implements AgentAdapter {
  public readonly kind = 'qodercli' as const;
  private readonly opts: AdapterOptions;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  private getProjectsRoot(): string {
    return path.join(this.opts.homeDir, '.qoder', 'projects');
  }

  async probe(): Promise<AgentProbeResult> {
    const binaryPath = await findBinary(
      'qodercli',
      this.opts.config?.binary,
      this.opts.homeDir
    );
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
      kind: 'qodercli',
      installed: Boolean(binaryPath),
      binaryPath,
      version,
      sessionDir,
      sessionDirReadable
    };
  }

  private parseQoderFile(filePath: string): DiscoveredSession | null {
    const { content } = readFileSafe(filePath);
    if (content === null) {
      // Gracefully skip files with EPERM/EACCES
      return null;
    }
    try {
      const stat = fs.statSync(filePath);
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const externalSessionId = path.basename(filePath, '.jsonl');
      let cwd = '';
      let title = '';
      let preview = '';
      let stepCount = 0;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
          if (!cwd && typeof obj.workingDirectory === 'string') cwd = obj.workingDirectory;
          const role = String(obj.role ?? obj.type ?? '');
          const msgObj = (obj.message as Record<string, unknown> | undefined) ?? obj;
          const text = extractTextContent(msgObj.content ?? obj.content ?? obj.text ?? '');
          if (role === 'user' || role === 'assistant' || role === 'human') {
            stepCount++;
            if (!title && (role === 'user' || role === 'human') && text) {
              title = text.slice(0, 80);
            }
            if (text) preview = text.slice(0, 140);
          }
        } catch {
          // ignore malformed line
        }
      }

      return {
        agent: 'qodercli',
        externalSessionId,
        title: title || path.basename(cwd || filePath),
        preview: preview || '(empty qoder session)',
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
      const transcriptDir = path.join(root, dirEntry.name, 'transcript');
      if (!fs.existsSync(transcriptDir)) continue;
      let files: fs.Dirent[] = [];
      try {
        files = fs.readdirSync(transcriptDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const fileEntry of files) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
        const parsed = this.parseQoderFile(path.join(transcriptDir, fileEntry.name));
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
    const transcriptDir = path.join(
      this.getProjectsRoot(),
      encodeQoderCwd(cwd),
      'transcript'
    );
    if (!fs.existsSync(transcriptDir)) return null;
    const candidates: DiscoveredSession[] = [];
    for (const entry of fs.readdirSync(transcriptDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(transcriptDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < sinceMs) continue;
        const parsed = this.parseQoderFile(fullPath);
        if (parsed) candidates.push(parsed);
      } catch {
        // ignore unreadable
      }
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0] ?? null;
  }

  buildStartCommand(req: StartSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'qodercli';
    const permArgs = mapPermissionFlags('qodercli', req.permissionMode ?? 'default');
    const args: string[] = [
      ...(this.opts.config?.defaultArgs ?? []),
      '-w',
      req.cwd,
      ...permArgs
    ];
    if (req.model) args.push('-m', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);
    if (req.initialPrompt) args.push('-i', req.initialPrompt);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks ?? true,
        shellFunctionName: 'qodercli',
        hasExplicitBinary: Boolean(this.opts.config?.binary?.trim())
      })
    };
  }

  buildResumeCommand(req: ResumeSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'qodercli';
    const permArgs = mapPermissionFlags('qodercli', req.permissionMode ?? 'default');
    const args: string[] = [
      ...(this.opts.config?.defaultArgs ?? []),
      '-w',
      req.cwd,
      '--resume',
      req.externalSessionId,
      ...permArgs
    ];
    if (req.model) args.push('-m', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks ?? true,
        shellFunctionName: 'qodercli',
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
        const role = String(obj.role ?? obj.type ?? 'system');
        const msgObj = (obj.message as Record<string, unknown> | undefined) ?? obj;
        const ts =
          typeof obj.timestamp === 'string'
            ? obj.timestamp
            : new Date().toISOString();
        const text = extractTextContent(msgObj.content ?? obj.content ?? obj.text ?? '');
        let kind: ProgressEventItem['kind'] = 'system';
        if (role === 'user' || role === 'human') kind = 'user';
        else if (role === 'assistant') kind = 'assistant';
        else if (role.includes('tool')) kind = 'tool_call';
        if (text) {
          events.push({
            timestamp: ts,
            kind,
            title: role,
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
        `Qoder transcript file not found for ${session.externalSessionId}`,
        404
      );
    }

    const { content, error } = readFileSafe(sourceFile);
    if (content === null) {
      throw new AgentHubError(
        'BUNDLE_EXPORT_FAILED',
        `Cannot read Qoder transcript (${error ?? 'permission error'}): ${sourceFile}`,
        403
      );
    }

    fs.mkdirSync(stagingDir, { recursive: true });
    const filename = path.basename(sourceFile);
    fs.writeFileSync(path.join(stagingDir, filename), content, 'utf8');

    const manifest: SessionBundleManifest = {
      version: 1,
      agent: 'qodercli',
      externalSessionId: session.externalSessionId,
      sourceHome: this.opts.homeDir,
      sourceCwd: session.cwd,
      title: session.title || filename,
      createdAt: new Date().toISOString(),
      files: [filename],
      metadata: {
        originalFilename: filename
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
        `Qoder bundle file missing: ${filename}`,
        400
      );
    }

    const targetDir = path.join(
      this.getProjectsRoot(),
      encodeQoderCwd(rule.targetCwd),
      'transcript'
    );
    fs.mkdirSync(targetDir, { recursive: true });
    const destFile = path.join(targetDir, filename);

    const raw = fs.readFileSync(srcFile, 'utf8');
    const rewritten = rewriteJsonlCwdLines(raw, rule);
    fs.writeFileSync(destFile, rewritten, 'utf8');

    return {
      externalSessionId: manifest.externalSessionId,
      targetSessionFilePath: destFile,
      fallbackContextFile: null,
      warnings: []
    };
  }
}
