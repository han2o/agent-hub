import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  rewritePath,
  type AgentEntryConfig,
  type AgentKind,
  type AgentProbeResult,
  type DiscoveredSession,
  type ImportBundleResult,
  type PathMappingRule,
  type PermissionMode,
  type ProgressEventItem,
  type ProgressSnapshot,
  type ResumeSessionRequest,
  type SessionBundleManifest,
  type SessionRecord,
  type SessionState,
  type StartSessionRequest
} from '@agent-hub/protocol';

const execFileAsync = promisify(execFile);

export interface AdapterOptions {
  homeDir: string;
  dataDir: string;
  config?: AgentEntryConfig;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  shellCommand: string;
  permissionArgs: string[];
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  probe(): Promise<AgentProbeResult>;
  discoverSessions(limit?: number): Promise<DiscoveredSession[]>;
  findLatestSessionForCwd(
    cwd: string,
    sinceMs?: number
  ): Promise<DiscoveredSession | null>;
  buildStartCommand(req: StartSessionRequest): CommandInvocation;
  buildResumeCommand(req: ResumeSessionRequest): CommandInvocation;
  buildFallbackResumeCommand?(req: ResumeSessionRequest): CommandInvocation | null;
  observeProgress(
    session: SessionRecord,
    ptyTail: string,
    processAlive: boolean
  ): Promise<ProgressSnapshot>;
  exportBundle(
    session: {
      externalSessionId: string;
      sessionFilePath?: string | null;
      cwd: string;
      title?: string;
    },
    stagingDir: string
  ): Promise<SessionBundleManifest>;
  importBundle(
    manifest: SessionBundleManifest,
    extractedDir: string,
    rule: PathMappingRule
  ): Promise<ImportBundleResult>;
}

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*(\x07|\x1B\\)/g, '');
}

export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function joinShellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}

export function buildShellInvocation(
  bin: string,
  args: string[],
  opts: {
    preserveShellHooks?: boolean;
    shellFunctionName?: string;
    hasExplicitBinary?: boolean;
  } = {}
): string {
  if (opts.preserveShellHooks && !opts.hasExplicitBinary && opts.shellFunctionName) {
    const inner = joinShellCommand([opts.shellFunctionName, ...args]);
    return `/bin/zsh -ic ${shellQuote(inner)}`;
  }
  return joinShellCommand([bin, ...args]);
}

export async function findBinary(
  name: string,
  override?: string,
  homeDir = os.homedir()
): Promise<string | null> {
  if (override && override.trim()) {
    const expanded = override.startsWith('~/')
      ? path.join(homeDir, override.slice(2))
      : override;
    if (fs.existsSync(expanded)) return expanded;
  }

  const candidatePaths = [
    path.join(homeDir, '.local', 'bin', name),
    path.join(homeDir, '.npm-global', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
    path.join('/usr/bin', name)
  ];

  try {
    const { stdout } = await execFileAsync('which', [name], { timeout: 2000 });
    const found = stdout.trim().split('\n')[0]?.trim();
    if (found && fs.existsSync(found)) return found;
  } catch {
    // Fallback to well-known locations
  }

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function getBinaryVersion(bin: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
      timeout: 3000
    });
    const out = (stdout || stderr).trim();
    return out.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function detectApprovalPrompt(ptyTail: string): string | null {
  const clean = stripAnsi(ptyTail);
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-15);
  if (lines.length === 0) return null;

  const patterns = [
    /\b(allow|approve|permit)\b.*\?/i,
    /do you want to (proceed|continue|run|allow|execute|edit)/i,
    /permission (required|prompt|check)/i,
    /\[(y\/N|Y\/n|yes\/no)\]/i,
    /\(y\/n\)/i,
    /press enter to (continue|approve|allow)/i,
    /1\.\s*(yes|allow)/i
  ];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (patterns.some((p) => p.test(line))) {
      return lines.slice(Math.max(0, i - 1), i + 2).join(' | ');
    }
  }
  return null;
}

export function mapPermissionFlags(
  agent: AgentKind,
  mode: PermissionMode
): string[] {
  switch (agent) {
    case 'agy':
      if (mode === 'accept_edits') return ['--mode', 'accept-edits'];
      if (mode === 'auto') return ['--mode', 'auto'];
      if (mode === 'plan') return ['--mode', 'plan'];
      if (mode === 'bypass') return ['--dangerously-skip-permissions'];
      return [];
    case 'qodercli':
      if (mode === 'accept_edits') return ['--permission-mode', 'accept_edits'];
      if (mode === 'auto') return ['--permission-mode', 'auto'];
      if (mode === 'plan') return ['--permission-mode', 'default'];
      if (mode === 'bypass') return ['--dangerously-skip-permissions'];
      return [];
    case 'claude':
      if (mode === 'accept_edits') return ['--permission-mode', 'acceptEdits'];
      if (mode === 'auto') return ['--permission-mode', 'acceptEdits'];
      if (mode === 'plan') return ['--permission-mode', 'plan'];
      if (mode === 'bypass') return ['--dangerously-skip-permissions'];
      return [];
    case 'pi':
      return [];
  }
}

export function readFileSafe(filePath: string): { content: string | null; error?: string } {
  try {
    return { content: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: null, error: msg };
  }
}

export function readJsonlLines(filePath: string, maxLines = 200): {
  lines: Record<string, unknown>[];
  rawLines: string[];
  mtimeMs: number;
  error?: string;
} {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const allRaw = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const sliced = maxLines > 0 && allRaw.length > maxLines
      ? allRaw.slice(allRaw.length - maxLines)
      : allRaw;
    const parsed: Record<string, unknown>[] = [];
    for (const line of sliced) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') {
          parsed.push(obj as Record<string, unknown>);
        }
      } catch {
        // Ignore partial line while flushing
      }
    }
    return { lines: parsed, rawLines: sliced, mtimeMs: stat.mtimeMs };
  } catch (err) {
    return {
      lines: [],
      rawLines: [],
      mtimeMs: 0,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

const CWD_KEYS = new Set([
  'cwd',
  'workingDirectory',
  'workingDir',
  'projectPath',
  'workspacePath',
  'rootPath'
]);

function rewriteObjectCwdFields(value: unknown, rule: PathMappingRule): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteObjectCwdFields(item, rule));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (CWD_KEYS.has(k) && typeof v === 'string' && v.startsWith('/')) {
      out[k] = rewritePath(v, rule);
    } else if (v && typeof v === 'object') {
      out[k] = rewriteObjectCwdFields(v, rule);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function rewriteJsonlCwdLines(content: string, rule: PathMappingRule): string {
  const lines = content.split('\n');
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    try {
      const parsed = JSON.parse(trimmed);
      const updated = rewriteObjectCwdFields(parsed, rule);
      return JSON.stringify(updated);
    } catch {
      return line;
    }
  });
  return rewritten.join('\n');
}

export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text);
        else if (typeof b.content === 'string') parts.push(b.content);
        else if (typeof b.name === 'string') parts.push(`[tool:${b.name}]`);
      }
    }
    return parts.join(' ').trim();
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.message === 'string') return obj.message;
  }
  return '';
}

export function inferStateFromEventsAndPty(opts: {
  events: ProgressEventItem[];
  fileMtimeMs: number;
  ptyTail: string;
  processAlive: boolean;
  currentState?: SessionState;
}): { state: SessionState; approvalPrompt: string | null } {
  if (!opts.processAlive) {
    return {
      state: opts.currentState === 'HANDED_OFF' ? 'HANDED_OFF' : 'EXITED',
      approvalPrompt: null
    };
  }

  const approval = detectApprovalPrompt(opts.ptyTail);
  if (approval) {
    return { state: 'WAITING_APPROVAL', approvalPrompt: approval };
  }

  const recentFileWrite =
    opts.fileMtimeMs > 0 && Date.now() - opts.fileMtimeMs < 5000;
  const lastEvent = opts.events[opts.events.length - 1];
  if (recentFileWrite || lastEvent?.kind === 'tool_call') {
    return { state: 'RUNNING', approvalPrompt: null };
  }

  // Also check spinner characters in recent PTY tail
  const tailLines = stripAnsi(opts.ptyTail)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' ');
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Thinking|Running\b/i.test(tailLines)) {
    return { state: 'RUNNING', approvalPrompt: null };
  }

  return { state: 'IDLE', approvalPrompt: null };
}

export function copyDirectoryRecursive(src: string, dest: string): string[] {
  const copied: string[] = [];
  if (!fs.existsSync(src)) return copied;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcEntry = path.join(src, entry.name);
    const destEntry = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyDirectoryRecursive(srcEntry, destEntry));
    } else if (entry.isFile()) {
      fs.copyFileSync(srcEntry, destEntry);
      copied.push(destEntry);
    }
  }
  return copied;
}
