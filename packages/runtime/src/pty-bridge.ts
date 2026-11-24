import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolvePtyBridgeScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../scripts/pty_bridge.py'),
    path.resolve(here, '../../scripts/pty_bridge.py')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot locate pty_bridge.py from ${here}`);
}

export interface PtySpawnOptions {
  command: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
}

export class PtySessionStream extends EventEmitter {
  private readonly proc: ChildProcessWithoutNullStreams;
  private closed = false;

  constructor(opts: PtySpawnOptions) {
    super();
    const scriptPath = resolvePtyBridgeScriptPath();
    const args = [
      '-u',
      scriptPath,
      '--cols',
      String(opts.cols ?? 120),
      '--rows',
      String(opts.rows ?? 36),
      ...(opts.cwd ? ['--cwd', opts.cwd] : []),
      '--',
      ...opts.command
    ];

    this.proc = spawn('python3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
    });

    this.proc.on('exit', (code) => {
      this.closed = true;
      this.emit('exit', code);
    });
  }

  private writeFrame(frameType: number, payload: Buffer): void {
    if (this.closed || !this.proc.stdin.writable) return;
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(frameType, 0);
    header.writeUInt32BE(payload.length, 1);
    this.proc.stdin.write(Buffer.concat([header, payload]));
  }

  write(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.writeFrame(1, buf);
  }

  resize(cols: number, rows: number): void {
    const payload = Buffer.from(JSON.stringify({ cols, rows }), 'utf8');
    this.writeFrame(2, payload);
  }

  detach(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (!this.proc.killed) {
        try {
          this.proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, 150).unref();
  }
}
