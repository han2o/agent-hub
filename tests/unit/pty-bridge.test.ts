import { describe, expect, it } from 'vitest';
import { PtySessionStream } from '@agent-hub/runtime';

describe('PtySessionStream (pty_bridge.py)', () => {
  it('streams stdin/stdout and handles resize cleanly', async () => {
    const stream = new PtySessionStream({
      command: [
        'python3',
        '-c',
        'import sys; sys.stdout.write("READY\\n"); sys.stdout.flush(); line = sys.stdin.readline(); sys.stdout.write("ECHO:" + line); sys.stdout.flush()'
      ],
      cols: 100,
      rows: 30
    });

    let collected = '';
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stream.detach();
        reject(new Error(`PTY bridge timed out. Output so far: ${collected}`));
      }, 6000);

      let sentInput = false;
      stream.on('data', (chunk: Buffer) => {
        collected += chunk.toString('utf8');
        if (!sentInput && collected.includes('READY')) {
          sentInput = true;
          stream.resize(132, 42);
          stream.write('hello-pty\n');
        }
      });

      stream.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      stream.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    expect(collected).toContain('ECHO:hello-pty');
  });
});
