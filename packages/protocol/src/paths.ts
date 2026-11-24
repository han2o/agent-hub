import path from 'node:path';
import type { PathMappingRule } from './types.js';

/**
 * Normalize Git remote URLs across SSH/HTTPS/SCP formats into canonical `<host>/<owner>/<repo>`.
 * Examples:
 * - git@github.com:org/repo.git -> github.com/org/repo
 * - ssh://git@gitlab.example.com:22/team/app.git -> gitlab.example.com/team/app
 * - https://user@git.example.com/org/repo.git/ -> git.example.com/org/repo
 */
export function normalizeGitOriginUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!trimmed) return '';

  // SCP-like syntax: git@host:path/to/repo
  const scpMatch = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scpMatch && !trimmed.includes('://')) {
    const host = scpMatch[1].toLowerCase();
    const repoPath = scpMatch[2].replace(/^\/+/, '').toLowerCase();
    return `${host}/${repoPath}`;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const port =
      parsed.port && !['22', '80', '443'].includes(parsed.port)
        ? `:${parsed.port}`
        : '';
    const repoPath = parsed.pathname.replace(/^\/+/, '').toLowerCase();
    return `${host}${port}/${repoPath}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function extractRepoName(urlOrPath: string): string {
  const cleaned = urlOrPath.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!cleaned) return 'repo';
  const lastSegment = cleaned.split(/[/:]/).filter(Boolean).pop();
  return lastSegment || 'repo';
}

function normalizePosix(p: string): string {
  if (!p) return p;
  return path.posix.normalize(p).replace(/\/+$/, '') || '/';
}

function replacePrefix(input: string, fromPrefix: string, toPrefix: string): string | null {
  const normFrom = normalizePosix(fromPrefix);
  const normTo = normalizePosix(toPrefix);
  const normInput = normalizePosix(input);
  if (!normFrom || !normTo) return null;

  if (normInput === normFrom) {
    return normTo;
  }
  const prefixWithSlash = normFrom === '/' ? '/' : `${normFrom}/`;
  if (normInput.startsWith(prefixWithSlash)) {
    const suffix = normInput.slice(prefixWithSlash.length);
    return normTo === '/' ? `/${suffix}` : `${normTo}/${suffix}`;
  }
  return null;
}

/**
 * Rewrite a Mac path to a Mini path according to priority rules:
 * 1. Exact `sourceCwd` -> `targetCwd`
 * 2. Explicit `repoMappings` (longest prefix first)
 * 3. `sourceWorkspaceRoots[i]` -> `targetWorkspaceRoots[i]` (longest prefix first)
 * 4. `sourceHome` -> `targetHome`
 */
export function rewritePath(inputPath: string, rule: PathMappingRule): string {
  if (!inputPath || !inputPath.startsWith('/')) {
    return inputPath;
  }

  // 1. Exact sourceCwd -> targetCwd
  const cwdReplaced = replacePrefix(inputPath, rule.sourceCwd, rule.targetCwd);
  if (cwdReplaced !== null) {
    return cwdReplaced;
  }

  // 2. Explicit repoMappings (longest match first)
  const sortedMappings = [...(rule.repoMappings ?? [])].sort(
    (a, b) => normalizePosix(b.sourceCwd).length - normalizePosix(a.sourceCwd).length
  );
  for (const mapping of sortedMappings) {
    const replaced = replacePrefix(inputPath, mapping.sourceCwd, mapping.targetCwd);
    if (replaced !== null) {
      return replaced;
    }
  }

  // 3. Workspace root mappings (longest match first)
  const srcRoots = rule.sourceWorkspaceRoots ?? [];
  const dstRoots = rule.targetWorkspaceRoots ?? [];
  const pairedRoots = srcRoots
    .map((src, idx) => ({
      src,
      dst: dstRoots[idx] ?? dstRoots[0] ?? ''
    }))
    .filter((item) => item.src && item.dst)
    .sort((a, b) => normalizePosix(b.src).length - normalizePosix(a.src).length);

  for (const pair of pairedRoots) {
    const replaced = replacePrefix(inputPath, pair.src, pair.dst);
    if (replaced !== null) {
      return replaced;
    }
  }

  // 4. Fallback: sourceHome -> targetHome
  const homeReplaced = replacePrefix(inputPath, rule.sourceHome, rule.targetHome);
  if (homeReplaced !== null) {
    return homeReplaced;
  }

  return inputPath;
}

/**
 * Pi encodes `/Users/alice/Desktop` into directory `--Users-alice-Desktop--`.
 * This function returns the inner segment `Users-alice-Desktop`.
 */
export function encodePiCwd(cwd: string): string {
  const norm = normalizePosix(cwd);
  return norm.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'root';
}

export function encodePiSessionDirName(cwd: string): string {
  return `--${encodePiCwd(cwd)}--`;
}

/**
 * Claude Code encodes `/Users/alice/Workspace/foo.bar` into `-Users-alice-Workspace-foo-bar`.
 */
export function encodeClaudeCwd(cwd: string): string {
  const norm = normalizePosix(cwd);
  return norm.replace(/[\/._\\: ]/g, '-');
}

/**
 * Qoder CLI encodes `/Users/alice/Workspace/api.service` into `-Users-alice-Workspace-api-service`.
 */
export function encodeQoderCwd(cwd: string): string {
  const norm = normalizePosix(cwd);
  return norm.replace(/[\/.]/g, '-');
}

/**
 * Rewrite Antigravity `conversation_summaries.workspace_uris` JSON array string,
 * e.g. `["file:///Users/alice/Workspace/repo"]` -> `["file:///Users/mini/Workspace/repo"]`.
 */
export function rewriteFileUriArrayJson(rawJson: string, rule: PathMappingRule): string {
  if (!rawJson || !rawJson.trim()) return rawJson;
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return rawJson;
    const mapped = parsed.map((item) => {
      if (typeof item !== 'string') return item;
      if (item.startsWith('file://')) {
        const fsPath = decodeURIComponent(item.slice('file://'.length));
        const rewritten = rewritePath(fsPath, rule);
        return `file://${encodeURI(rewritten).replace(/#/g, '%23')}`;
      }
      return rewritePath(item, rule);
    });
    return JSON.stringify(mapped);
  } catch {
    return rawJson;
  }
}

export function sanitizeBranchSegment(input: string): string {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'detached'
  );
}
