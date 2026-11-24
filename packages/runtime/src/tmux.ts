import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentHubError } from '@agent-hub/protocol';

const execFileAsync = promisify(execFile);

export interface TmuxSessionInfo {
  name: string;
  createdAtEpoch: number;
  panePid: number | null;
  paneCwd: string;
}

export interface TmuxManagerOptions {
  socketName?: string;
}

export class TmuxManager {
  public readonly socketName?: string;

  constructor(opts: TmuxManagerOptions = {}) {
    this.socketName = opts.socketName;
  }

  baseArgs(): string[] {
    return this.socketName ? ['-L', this.socketName] : [];
  }

  attachCommand(sessionName: string): string[] {
    return ['tmux', ...this.baseArgs(), 'attach-session', '-t', sessionName];
  }

  private async runTmux(args: string[], timeout = 5000): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('tmux', [...this.baseArgs(), ...args], { timeout });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('tmux', ['-V'], { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('tmux', ['-V'], { timeout: 2000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async listManagedSessions(prefix = 'ah-'): Promise<TmuxSessionInfo[]> {
    try {
      const { stdout } = await this.runTmux([
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_created}\t#{pane_pid}\t#{pane_current_path}'
      ]);
      const items: TmuxSessionInfo[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, createdRaw, pidRaw, paneCwd] = trimmed.split('\t');
        if (!name || (prefix && !name.startsWith(prefix))) continue;
        items.push({
          name,
          createdAtEpoch: Number(createdRaw ?? 0),
          panePid: pidRaw ? Number(pidRaw) : null,
          paneCwd: paneCwd ?? ''
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.runTmux(['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  async getPanePid(name: string): Promise<number | null> {
    try {
      const { stdout } = await this.runTmux([
        'list-panes',
        '-t',
        name,
        '-F',
        '#{pane_pid}'
      ]);
      const pid = Number(stdout.trim().split('\n')[0]);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  async createSession(opts: {
    name: string;
    cwd: string;
    shellCommand: string;
    cols?: number;
    rows?: number;
  }): Promise<number | null> {
    try {
      await this.runTmux([
        'new-session',
        '-d',
        '-s',
        opts.name,
        '-c',
        opts.cwd,
        '-x',
        String(opts.cols ?? 120),
        '-y',
        String(opts.rows ?? 36),
        opts.shellCommand
      ]);
      // Keep pane alive cleanly only if needed? No, exit indicates session ended.
      return this.getPanePid(opts.name);
    } catch (err) {
      throw new AgentHubError(
        'TMUX_ERROR',
        `Failed to create tmux session ${opts.name}: ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }
  }

  async capturePane(name: string, lines = 80): Promise<string> {
    try {
      const { stdout } = await this.runTmux([
        'capture-pane',
        '-t',
        name,
        '-p',
        '-S',
        `-${lines}`
      ]);
      return stdout;
    } catch {
      return '';
    }
  }

  async sendText(name: string, text: string): Promise<void> {
    try {
      await this.runTmux(['send-keys', '-l', '-t', name, '--', text]);
      await this.runTmux(['send-keys', '-t', name, 'Enter']);
    } catch (err) {
      throw new AgentHubError(
        'TMUX_ERROR',
        `Failed to send text to tmux session ${name}: ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }
  }

  async sendKey(name: string, key: string): Promise<void> {
    try {
      await this.runTmux(['send-keys', '-t', name, key]);
    } catch {
      // ignore if already exited
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.runTmux(['kill-session', '-t', name]);
    } catch {
      // already dead
    }
  }

  async waitForExit(name: string, timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.hasSession(name))) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return !(await this.hasSession(name));
  }

  async gracefulStop(name: string, timeoutMs = 6000): Promise<void> {
    if (!(await this.hasSession(name))) return;
    // Send Ctrl+C twice, then Ctrl+D twice, then kill-session if still hanging
    await this.sendKey(name, 'C-c');
    await new Promise((r) => setTimeout(r, 350));
    if (await this.waitForExit(name, 1000)) return;

    await this.sendKey(name, 'C-c');
    await new Promise((r) => setTimeout(r, 250));
    await this.sendKey(name, 'C-d');
    await new Promise((r) => setTimeout(r, 250));
    await this.sendKey(name, 'C-d');

    const exited = await this.waitForExit(name, Math.max(1500, timeoutMs - 1850));
    if (!exited) {
      await this.killSession(name);
      await this.waitForExit(name, 1500);
    }
  }
}
