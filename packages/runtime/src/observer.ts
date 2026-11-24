import type { AdapterRegistry } from '@agent-hub/adapters';
import type { ProgressSnapshot, SessionRecord } from '@agent-hub/protocol';
import type { TmuxManager } from './tmux.js';

export class SessionObserver {
  private readonly registry: AdapterRegistry;
  private readonly tmux: TmuxManager;

  constructor(registry: AdapterRegistry, tmux: TmuxManager) {
    this.registry = registry;
    this.tmux = tmux;
  }

  async observe(session: SessionRecord): Promise<ProgressSnapshot> {
    const adapter = this.registry.get(session.agent);
    const alive = session.tmuxName
      ? await this.tmux.hasSession(session.tmuxName)
      : false;
    const ptyTail = alive ? await this.tmux.capturePane(session.tmuxName, 60) : '';
    const snapshot = await adapter.observeProgress(session, ptyTail, alive);

    if (session.state === 'HANDING_OFF' || session.state === 'HANDED_OFF') {
      snapshot.state = session.state;
      snapshot.approvalPrompt = null;
    }
    return snapshot;
  }
}
