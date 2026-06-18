import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acquireExecutionLock,
  finalizeRecoveredExecutionLock,
  releaseExecutionLock,
  updateExecutionLock,
} from '../scripts/execution-lock.js';

const makeLockPath = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lock-test-'));
  return path.join(root, 'execution.lock');
};

describe('task execution lock', () => {
  it('does not take over a live owner', () => {
    const lockPath = makeLockPath();
    const live = acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step' });

    assert.throws(
      () => acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'advance', staleAfterMs: 0 }),
      /task-locked/
    );
    assert.equal(releaseExecutionLock(live), true);
  });

  it('recovers a stale lock only when the owner process is dead', () => {
    const lockPath = makeLockPath();
    fs.writeFileSync(lockPath, JSON.stringify({
      ownerId: 'dead-owner',
      pid: 2_147_483_647,
      acquiredAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
      lockEpoch: 4,
    }));

    const recovered = acquireExecutionLock({
      lockPath,
      taskId: 'W6-A',
      command: 'step',
      staleAfterMs: 0,
    });

    const recovery = recovered.recoveries[0];
    assert.equal(recovery.previousLock.ownerId, 'dead-owner');
    assert.equal(fs.existsSync(recovery.markerPath), true);
    assert.equal(finalizeRecoveredExecutionLock(recovered), true);
    assert.equal(fs.existsSync(recovery.markerPath), false);
    assert.equal(releaseExecutionLock(recovered), true);
  });

  it('replays an orphan recovery marker after a recovery process crashes', () => {
    const lockPath = makeLockPath();
    const stale = {
      ownerId: 'dead-owner',
      pid: 2_147_483_647,
      acquiredAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
      lockEpoch: 4,
    };
    fs.writeFileSync(`${lockPath}.stale.${stale.ownerId}`, JSON.stringify(stale));

    const replayed = acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step' });

    assert.equal(replayed.recovered.recoveryId, 'dead-owner:2000-01-01T00:00:00.000Z');
    assert.equal(finalizeRecoveredExecutionLock(replayed), true);
    assert.equal(releaseExecutionLock(replayed), true);
  });

  it('completes recovery after crashing between marker link and canonical unlink', () => {
    const lockPath = makeLockPath();
    const stale = {
      ownerId: 'dead-owner',
      pid: 2_147_483_647,
      acquiredAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
      lockEpoch: 4,
    };
    fs.writeFileSync(lockPath, JSON.stringify(stale));

    assert.throws(
      () => acquireExecutionLock({
        lockPath,
        taskId: 'W6-A',
        command: 'step',
        staleAfterMs: 0,
        faultInjector: point => {
          if (point === 'after-recovery-link') throw new Error('simulated-crash');
        },
      }),
      /simulated-crash/
    );
    const markerPath = `${lockPath}.stale.${stale.ownerId}`;
    assert.equal(fs.statSync(lockPath).ino, fs.statSync(markerPath).ino);

    const resumed = acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step', staleAfterMs: 0 });
    assert.equal(resumed.recoveries.length, 1);
    assert.notEqual(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).ownerId, 'dead-owner');
    finalizeRecoveredExecutionLock(resumed);
    releaseExecutionLock(resumed);
  });

  it('publishes initial and updated canonical records atomically', () => {
    const lockPath = makeLockPath();
    assert.throws(
      () => acquireExecutionLock({
        lockPath,
        taskId: 'W6-A',
        command: 'step',
        faultInjector: point => {
          if (point === 'after-acquire-temp-fsync') throw new Error('simulated-create-crash');
        },
      }),
      /simulated-create-crash/
    );
    assert.equal(fs.existsSync(lockPath), false);

    const lock = acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step' });
    const original = fs.readFileSync(lockPath, 'utf-8');
    assert.throws(
      () => updateExecutionLock(lock, { lockEpoch: 2 }, {
        faultInjector: point => {
          if (point === 'after-update-temp-fsync') throw new Error('simulated-update-crash');
        },
      }),
      /simulated-update-crash/
    );
    assert.equal(fs.readFileSync(lockPath, 'utf-8'), original);
    assert.doesNotThrow(() => JSON.parse(original));
    releaseExecutionLock(lock);
  });

  it('fails closed with an explicit error for a corrupt canonical record', () => {
    const lockPath = makeLockPath();
    fs.writeFileSync(lockPath, '{half-written');
    assert.throws(
      () => acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step', staleAfterMs: 0 }),
      /corrupt-execution-lock: explicit recovery required/
    );
    assert.equal(fs.readFileSync(lockPath, 'utf-8'), '{half-written');
  });

  it('returns every orphan recovery marker as a separate transaction', () => {
    const lockPath = makeLockPath();
    for (const [ownerId, acquiredAt] of [
      ['owner-a', '2000-01-01T00:00:00.000Z'],
      ['owner-b', '2001-01-01T00:00:00.000Z'],
    ]) {
      fs.writeFileSync(`${lockPath}.stale.${ownerId}`, JSON.stringify({
        ownerId,
        pid: 2_147_483_647,
        acquiredAt,
        heartbeatAt: acquiredAt,
        lockEpoch: 0,
      }));
    }

    const lock = acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step' });
    assert.deepEqual(lock.recoveries.map(item => item.previousLock.ownerId), ['owner-a', 'owner-b']);
    finalizeRecoveredExecutionLock(lock);
    assert.equal(lock.recoveries.every(item => !fs.existsSync(item.markerPath)), true);
    releaseExecutionLock(lock);
  });

  it('does not let a delayed recovery contender move the new owner lock', () => {
    const lockPath = makeLockPath();
    const stale = {
      ownerId: 'dead-owner',
      pid: 2_147_483_647,
      acquiredAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
      lockEpoch: 4,
    };
    fs.writeFileSync(`${lockPath}.stale.${stale.ownerId}`, JSON.stringify(stale));
    const winner = acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step' });
    const winnerOwner = JSON.parse(fs.readFileSync(lockPath, 'utf-8')).ownerId;

    assert.throws(
      () => acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'advance', staleAfterMs: 0 }),
      /task-locked/
    );
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).ownerId, winnerOwner);
    finalizeRecoveredExecutionLock(winner);
    releaseExecutionLock(winner);
  });

  it('does not let an old owner delete a replacement lock', () => {
    const lockPath = makeLockPath();
    const old = acquireExecutionLock({ lockPath, taskId: 'W6-A', command: 'step' });
    fs.rmSync(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify({ ownerId: 'new-owner', pid: process.pid }));

    assert.equal(releaseExecutionLock(old), false);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).ownerId, 'new-owner');
  });
});
