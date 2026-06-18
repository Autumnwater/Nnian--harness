import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const processIsAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
};

const fsyncDirectory = dir => {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const readRecord = (filePath, kind) => {
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.ownerId !== 'string' || record.ownerId.length === 0) {
      throw new Error('invalid record');
    }
    return record;
  } catch {
    throw new Error(`corrupt-${kind}: explicit recovery required (${filePath})`);
  }
};

const writeTempRecord = (lockPath, record, operation) => {
  const tempPath = `${lockPath}.${operation}.${record.ownerId}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return tempPath;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const getPendingRecoveries = lockPath => {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.stale.`;
  return fs.readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .map(name => {
      const markerPath = path.join(dir, name);
      const previousLock = readRecord(markerPath, 'recovery-marker');
      const occurredAt = previousLock.acquiredAt || previousLock.heartbeatAt;
      if (!Number.isFinite(Date.parse(occurredAt || ''))) {
        throw new Error(`corrupt-recovery-marker: explicit recovery required (${markerPath})`);
      }
      return {
        recoveryId: `${previousLock.ownerId}:${occurredAt}`,
        markerPath,
        previousLock,
      };
    })
    .sort((a, b) => a.recoveryId.localeCompare(b.recoveryId));
};

const staleOwnerCanBeRecovered = (record, staleAfterMs) => {
  const heartbeatAt = Date.parse(record.heartbeatAt || record.acquiredAt || '');
  return Number.isFinite(heartbeatAt) &&
    Date.now() - heartbeatAt >= staleAfterMs &&
    !processIsAlive(record.pid);
};

const claimOrCompleteStaleLock = (lockPath, staleAfterMs, faultInjector) => {
  const record = readRecord(lockPath, 'execution-lock');
  if (!staleOwnerCanBeRecovered(record, staleAfterMs)) return false;

  const markerPath = `${lockPath}.stale.${encodeURIComponent(record.ownerId)}`;
  try {
    fs.linkSync(lockPath, markerPath);
    fsyncDirectory(path.dirname(lockPath));
    faultInjector?.('after-recovery-link');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const canonicalStat = fs.statSync(lockPath);
  const markerStat = fs.statSync(markerPath);
  if (canonicalStat.dev !== markerStat.dev || canonicalStat.ino !== markerStat.ino) {
    return false;
  }
  const markerRecord = readRecord(markerPath, 'recovery-marker');
  if (markerRecord.ownerId !== record.ownerId || !staleOwnerCanBeRecovered(markerRecord, staleAfterMs)) {
    return false;
  }

  fs.unlinkSync(lockPath);
  fsyncDirectory(path.dirname(lockPath));
  return true;
};

export const acquireExecutionLock = ({
  lockPath,
  taskId,
  command,
  staleAfterMs = 60_000,
  faultInjector,
}) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const ownerId = randomUUID();

  for (let attempt = 0; attempt < 2; attempt++) {
    const recoveries = getPendingRecoveries(lockPath);
    const acquiredAt = new Date().toISOString();
    const record = {
      taskId,
      command,
      ownerId,
      pid: process.pid,
      acquiredAt,
      heartbeatAt: acquiredAt,
      lockEpoch: 0,
    };
    const tempPath = writeTempRecord(lockPath, record, 'acquire');
    try {
      faultInjector?.('after-acquire-temp-fsync');
      fs.linkSync(tempPath, lockPath);
      fsyncDirectory(path.dirname(lockPath));
      return {
        lockPath,
        ownerId,
        record,
        recoveries,
        recovered: recoveries[0] || null,
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (attempt === 0 && claimOrCompleteStaleLock(lockPath, staleAfterMs, faultInjector)) continue;
      throw new Error(`task-locked: ${taskId} already has an active execution lock (${lockPath})`);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
  throw new Error(`task-locked: unable to acquire ${lockPath}`);
};

export const updateExecutionLock = (lock, updates, { faultInjector } = {}) => {
  const current = readRecord(lock.lockPath, 'execution-lock');
  if (current.ownerId !== lock.ownerId) throw new Error('task-lock-owner-mismatch');
  const nextRecord = { ...current, ...updates, ownerId: lock.ownerId };
  const tempPath = writeTempRecord(lock.lockPath, nextRecord, 'update');
  try {
    faultInjector?.('after-update-temp-fsync');
    const latest = readRecord(lock.lockPath, 'execution-lock');
    if (latest.ownerId !== lock.ownerId) throw new Error('task-lock-owner-mismatch');
    fs.renameSync(tempPath, lock.lockPath);
    fsyncDirectory(path.dirname(lock.lockPath));
    lock.record = nextRecord;
    return { ...nextRecord };
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
};

export const finalizeRecoveredExecutionLock = lock => {
  if (!lock.recoveries || lock.recoveries.length === 0) return false;
  for (const recovery of lock.recoveries) {
    fs.rmSync(recovery.markerPath, { force: true });
  }
  fsyncDirectory(path.dirname(lock.lockPath));
  return true;
};

export const releaseExecutionLock = lock => {
  if (!fs.existsSync(lock.lockPath)) return false;
  let current;
  try {
    current = readRecord(lock.lockPath, 'execution-lock');
  } catch {
    return false;
  }
  if (current.ownerId !== lock.ownerId) return false;
  fs.rmSync(lock.lockPath);
  fsyncDirectory(path.dirname(lock.lockPath));
  return true;
};
