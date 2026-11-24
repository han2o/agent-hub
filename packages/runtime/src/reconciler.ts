import type { SessionRecord } from '@agent-hub/protocol';
import type { TmuxManager } from './tmux.js';

export interface ReconcileReport {
  reattached: string[];
  markedExited: string[];
  untrackedTmux: string[];
}

/**
 * Reconciles persisted session records against currently live `ah-*` tmux sessions
 * so restarting Hub or Companion never loses track of running agents.
 */
export async function reconcileTmuxSessions(
  sessions: SessionRecord[],
  tmux: TmuxManager,
  onMarkExited: (sessionId: string) => void | Promise<void>
): Promise<ReconcileReport> {
  const liveTmux = await tmux.listManagedSessions('ah-');
  const liveByName = new Map(liveTmux.map((t) => [t.name, t]));

  const trackedTmuxNames = new Set<string>();
  const reattached: string[] = [];
  const markedExited: string[] = [];

  for (const session of sessions) {
    if (!session.tmuxName) continue;
    trackedTmuxNames.add(session.tmuxName);

    const activeState =
      session.state === 'RUNNING' ||
      session.state === 'WAITING_APPROVAL' ||
      session.state === 'IDLE';

    if (liveByName.has(session.tmuxName)) {
      if (activeState) reattached.push(session.id);
    } else if (activeState) {
      await onMarkExited(session.id);
      markedExited.push(session.id);
    }
  }

  const untrackedTmux = liveTmux
    .filter((t) => !trackedTmuxNames.has(t.name))
    .map((t) => t.name);

  return { reattached, markedExited, untrackedTmux };
}
