#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { createRuntime } = require('../core/runtime');
const { start } = require('../core/syncWorker');
const { logger } = require('../core/logger');

const dataDir = path.resolve(__dirname, '..', '..', 'data');
const publicDir = path.resolve(__dirname, '..', '..', 'public');
const lockFile = path.join(dataDir, 'worker.lock');

fs.mkdirSync(dataDir, { recursive: true });

if (fs.existsSync(lockFile)) {
  const existing = fs.readFileSync(lockFile, 'utf8').trim();
  const pid = Number(existing);
  if (pid && pid !== process.pid) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) {
      logger.error({ pid }, 'standalone syncWorker already running, exiting');
      process.exit(2);
    }
    logger.warn({ stalePid: pid }, 'removing stale worker lock');
  }
}
fs.writeFileSync(lockFile, String(process.pid));

const runtime = createRuntime({ dataDir, publicDir });
runtime.store.load();

const worker = start(runtime);

function shutdown(signal) {
  logger.info({ signal }, 'standalone syncWorker shutting down');
  try { worker.stop(); } catch {}
  try { runtime.store.close(); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaughtException in standalone syncWorker');
  shutdown('uncaughtException');
});

logger.info({ pid: process.pid, dataDir }, 'standalone syncWorker ready');
