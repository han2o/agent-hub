import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

export async function packDirectoryToBuffer(sourceDir: string): Promise<Buffer> {
  const tmpFile = path.join(
    os.tmpdir(),
    `ah-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`
  );
  try {
    await tar.create(
      {
        gzip: true,
        file: tmpFile,
        cwd: sourceDir
      },
      fs.readdirSync(sourceDir)
    );
    return fs.readFileSync(tmpFile);
  } finally {
    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
  }
}

export async function unpackBufferToDirectory(
  buf: Buffer,
  destDir: string
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const tmpFile = path.join(
    os.tmpdir(),
    `ah-unpack-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`
  );
  try {
    fs.writeFileSync(tmpFile, buf);
    await tar.extract({
      file: tmpFile,
      cwd: destDir
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
  }
}
