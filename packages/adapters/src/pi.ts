import fs from 'node:fs';
import path from 'node:path';
import {
  AgentHubError,
  encodePiSessionDirName,
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
  readJsonlLines,
  rewriteJsonlCwdLines,
  type AdapterOptions,
  type AgentAdapter,
  type CommandInvocation
} from './base.js';

export class PiAdapter implements AgentAdapter {
  public readonly kind = 'pi' as const;
  private readonly opts: AdapterOptions;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  private getSessionsRoot(): string {
    return path.join(this.opts.homeDir, '.pi', 'agent', 'sessions');
  }

  async probe(): Promise<AgentProbeResult> {
    const binaryPath = await findBinary('pi', this.opts.config?.binary, this.opts.homeDir);
    const version = binaryPath ? await getBinaryVersion(binaryPath) : null;
    const sessionDir = this.getSessionsRoot();
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
      kind: 'pi',
      installed: Boolean(binaryPath),
      binaryPath,
      version,
      sessionDir,
      sessionDirReadable
    };
  }

  private parsePiFile(filePath: string): DiscoveredSession | null {
    try {
      const stat = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) return null;

      let header: Record<string, unknown> = {};
      try {
        header = JSON.parse(lines[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
      const externalSessionId =
        typeof header.id === 'string'
          ? header.id
          : path.basename(filePath, '.jsonl').split('_').pop() || path.basename(filePath, '.jsonl');
      const cwd = typeof header.cwd === 'string' ? header.cwd : '';

      let title = '';
      let preview = '';
      let stepCount = 0;

      for (const line of lines.slice(1)) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const type = String(obj.type ?? '');
          const role = String(obj.role ?? (obj.message as Record<string, unknown> | undefined)?.role ?? '');
          const msgObj = (obj.message as Record<string, unknown> | undefined) ?? obj;
          const text = extractTextContent(msgObj.content ?? obj.text ?? '');
          if (type === 'message' || role === 'user' || role === 'assistant') {
            stepCount++;
            if (!title && role === 'user' && text) {
              title = text.slice(0, 80);
            }
            if (text) preview = text.slice(0, 140);
          }
        } catch {
          // ignore invalid line
        }
      }

      return {
        agent: 'pi',
        externalSessionId,
        title: title || path.basename(cwd || filePath),
        preview: preview || '(empty pi session)',
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
    const root = this.getSessionsRoot();
    if (!fs.existsSync(root)) return [];

    const results: DiscoveredSession[] = [];
    for (const dirEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      const subDir = path.join(root, dirEntry.name);
      let files: fs.Dirent[] = [];
      try {
        files = fs.readdirSync(subDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const fileEntry of files) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
        const parsed = this.parsePiFile(path.join(subDir, fileEntry.name));
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
    const expectedDir = path.join(this.getSessionsRoot(), encodePiSessionDirName(cwd));
    if (!fs.existsSync(expectedDir)) return null;
    const candidates: DiscoveredSession[] = [];
    for (const file of fs.readdirSync(expectedDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(expectedDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < sinceMs) continue;
      const parsed = this.parsePiFile(fullPath);
      if (parsed) candidates.push(parsed);
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0] ?? null;
  }

  buildStartCommand(req: StartSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'pi';
    const permArgs = mapPermissionFlags('pi', req.permissionMode ?? 'default');
    const args: string[] = [...(this.opts.config?.defaultArgs ?? []), ...permArgs];
    if (req.model) args.push('--model', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);
    if (req.initialPrompt) args.push(req.initialPrompt);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks,
        shellFunctionName: 'pi',
        hasExplicitBinary: Boolean(this.opts.config?.binary?.trim())
      })
    };
  }

  buildResumeCommand(req: ResumeSessionRequest): CommandInvocation {
    const bin = this.opts.config?.binary?.trim() || 'pi';
    const permArgs = mapPermissionFlags('pi', req.permissionMode ?? 'default');
    const sessionRef = req.sessionFilePath || req.externalSessionId;
    const args: string[] = [
      ...(this.opts.config?.defaultArgs ?? []),
      '--session',
      sessionRef,
      ...permArgs
    ];
    if (req.model) args.push('--model', req.model);
    if (req.extraArgs?.length) args.push(...req.extraArgs);

    return {
      command: bin,
      args,
      permissionArgs: permArgs,
      shellCommand: buildShellInvocation(bin, args, {
        preserveShellHooks: this.opts.config?.preserveShellHooks,
        shellFunctionName: 'pi',
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
        const msgObj = (obj.message as Record<string, unknown> | undefined) ?? obj;
        const role = String(msgObj.role ?? obj.type ?? 'system');
        const ts =
          typeof obj.timestamp === 'string'
            ? obj.timestamp
            : new Date().toISOString();
        const text = extractTextContent(msgObj.content ?? obj.text ?? '');
        let kind: ProgressEventItem['kind'] = 'system';
        if (role === 'user') kind = 'user';
        else if (role === 'assistant') kind = 'assistant';
        else if (role === 'toolResult') kind = 'tool_result';
        if (
          role === 'assistant' &&
          Array.isArray(msgObj.content) &&
          msgObj.content.some(
            (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'toolCall'
          )
        ) {
          kind = 'tool_call';
        }
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
        `Pi session file not found for ${session.externalSessionId}`,
        404
      );
    }

    fs.mkdirSync(stagingDir, { recursive: true });
    const filename = path.basename(sourceFile);
    fs.copyFileSync(sourceFile, path.join(stagingDir, filename));

    const manifest: SessionBundleManifest = {
      version: 1,
      agent: 'pi',
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
      manifest.files[0];
    if (!filename) {
      throw new AgentHubError('BUNDLE_IMPORT_FAILED', 'Missing pi session filename in bundle', 400);
    }
    const srcFile = path.join(extractedDir, filename);
    if (!fs.existsSync(srcFile)) {
      throw new AgentHubError('BUNDLE_IMPORT_FAILED', `Pi bundle file missing: ${filename}`, 400);
    }

    const targetDir = path.join(
      this.getSessionsRoot(),
      encodePiSessionDirName(rule.targetCwd)
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
