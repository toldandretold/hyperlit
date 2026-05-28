import { statSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { resolve } from 'path';

const LOG_PATH = resolve(import.meta.dirname, '..', '..', '..', 'storage', 'logs', 'laravel.log');

export function getLaravelLogPath() {
  return LOG_PATH;
}

export function snapshotLaravelLog() {
  try {
    return statSync(LOG_PATH).size;
  } catch {
    return 0;
  }
}

export function readLaravelLogSince(byteOffset) {
  try {
    const size = statSync(LOG_PATH).size;
    if (size <= byteOffset) return '';
    const length = size - byteOffset;
    const fd = openSync(LOG_PATH, 'r');
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, byteOffset);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return `[laravelLog read failed: ${e.message}]`;
  }
}

export function findLaravelErrors(tail) {
  if (!tail) return [];
  const lines = tail.split('\n');
  const errors = [];
  let currentBlock = null;
  for (const line of lines) {
    const isErrorHeader = /\b(ERROR|CRITICAL|EMERGENCY|ALERT)\b/.test(line) && /^\[\d{4}-\d{2}-\d{2}/.test(line);
    if (isErrorHeader) {
      if (currentBlock) errors.push(currentBlock);
      currentBlock = line;
    } else if (currentBlock) {
      if (/^\[\d{4}-\d{2}-\d{2}/.test(line) && !isErrorHeader) {
        errors.push(currentBlock);
        currentBlock = null;
      } else if (line.trim().length > 0) {
        currentBlock += '\n' + line;
        if (currentBlock.split('\n').length > 40) {
          errors.push(currentBlock + '\n[truncated]');
          currentBlock = null;
        }
      }
    }
  }
  if (currentBlock) errors.push(currentBlock);
  return errors;
}
