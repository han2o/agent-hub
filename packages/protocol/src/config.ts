import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { AppConfigSchema, type AppConfig } from './types.js';

export function resolveDefaultConfigPath(): string {
  if (process.env.AGENT_HUB_CONFIG) {
    return process.env.AGENT_HUB_CONFIG;
  }
  return path.join(os.homedir(), '.agent-hub', 'config.yaml');
}

export function expandHomeDir(p: string, homeDir = os.homedir()): string {
  if (!p) return p;
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  return p;
}

export function applyConfigDefaults(raw: Partial<AppConfig> = {}): AppConfig {
  const parsed = AppConfigSchema.parse(raw);
  const homeDir = parsed.homeDir ? expandHomeDir(parsed.homeDir) : os.homedir();
  const dataDir = parsed.dataDir
    ? expandHomeDir(parsed.dataDir, homeDir)
    : path.join(homeDir, '.agent-hub');
  const worktreesRoot = parsed.worktreesRoot
    ? expandHomeDir(parsed.worktreesRoot, homeDir)
    : path.join(dataDir, 'worktrees');
  const workspaceRoots =
    parsed.workspaceRoots.length > 0
      ? parsed.workspaceRoots.map((r) => expandHomeDir(r, homeDir))
      : [path.join(homeDir, 'Workspace')];

  const defaultPort = parsed.role === 'companion' ? 4781 : 4780;
  const port = raw.port ?? defaultPort;

  const authToken = process.env.AGENT_HUB_TOKEN ?? parsed.authToken;

  return {
    ...parsed,
    port,
    authToken,
    homeDir,
    dataDir,
    worktreesRoot,
    workspaceRoots,
    nodeId:
      raw.nodeId ??
      (parsed.role === 'companion' ? 'mac' : 'mini'),
    nodeName:
      raw.nodeName ??
      (parsed.role === 'companion' ? os.hostname() || 'Mac' : os.hostname() || 'Mac mini')
  };
}

export function loadAppConfig(configPath?: string): AppConfig {
  const resolved = configPath ?? resolveDefaultConfigPath();
  if (!fs.existsSync(resolved)) {
    return applyConfigDefaults({});
  }
  const content = fs.readFileSync(resolved, 'utf8');
  const raw = (YAML.parse(content) ?? {}) as Partial<AppConfig>;
  return applyConfigDefaults(raw);
}

export function saveAppConfig(configPath: string, config: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(config), 'utf8');
}
