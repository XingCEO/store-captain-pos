'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWindows = process.platform === 'win32';

test('standalone syncWorker entry boots and writes lock file', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulw-worker-'));
  const env = { ...process.env, ULW_DATA_DIR: dataDir, LOG_LEVEL: 'silent', DISABLE_BACKGROUND_WORKERS: '0' };

  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'workers', 'syncWorker.js')], {
    env,
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const lockPath = path.join(dataDir, 'worker.lock');
  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(lockPath)) {
      const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (pid === child.pid) { ready = true; break; }
    }
  }

  try {
    assert.equal(ready, true, `worker did not write lock file within 3s; stderr=${stderr.slice(0, 200)}`);

    // On POSIX, SIGTERM yields exit 0. On Windows .kill() always terminates abruptly,
    // so we only validate that the process exits at all.
    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve(code === null ? signal : code));
      child.kill(isWindows ? 'SIGTERM' : 'SIGTERM');
    });
    if (!isWindows) {
      assert.equal(exitCode, 0, 'worker should exit cleanly on SIGTERM on POSIX');
      assert.equal(fs.existsSync(lockPath), false, 'lock file should be removed on graceful shutdown');
    } else {
      // Windows: just confirm it died. Cleanup is best-effort on this platform.
      assert.ok(exitCode !== null, `worker did not exit; got ${exitCode}`);
    }
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
