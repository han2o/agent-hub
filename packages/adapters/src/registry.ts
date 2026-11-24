import type { AgentEntryConfig, AgentKind } from '@agent-hub/protocol';
import { AgyAdapter } from './agy.js';
import type { AgentAdapter } from './base.js';
import { ClaudeAdapter } from './claude.js';
import { PiAdapter } from './pi.js';
import { QoderAdapter } from './qoder.js';

export interface RegistryOptions {
  homeDir: string;
  dataDir: string;
  agents?: Partial<Record<AgentKind, AgentEntryConfig>>;
}

export class AdapterRegistry {
  private readonly adapters: Map<AgentKind, AgentAdapter>;

  constructor(opts: RegistryOptions) {
    this.adapters = new Map<AgentKind, AgentAdapter>([
      [
        'agy',
        new AgyAdapter({
          homeDir: opts.homeDir,
          dataDir: opts.dataDir,
          config: opts.agents?.agy
        })
      ],
      [
        'pi',
        new PiAdapter({
          homeDir: opts.homeDir,
          dataDir: opts.dataDir,
          config: opts.agents?.pi
        })
      ],
      [
        'claude',
        new ClaudeAdapter({
          homeDir: opts.homeDir,
          dataDir: opts.dataDir,
          config: opts.agents?.claude
        })
      ],
      [
        'qodercli',
        new QoderAdapter({
          homeDir: opts.homeDir,
          dataDir: opts.dataDir,
          config: opts.agents?.qodercli
        })
      ]
    ]);
  }

  get(kind: AgentKind): AgentAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`Unsupported agent adapter: ${kind}`);
    }
    return adapter;
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export function createDefaultRegistry(opts: RegistryOptions): AdapterRegistry {
  return new AdapterRegistry(opts);
}
