import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveAdvanceTransition, evaluateStageCheck } from '../scripts/workflow-core.js';

const attempt = { jobId: 'job-1', attemptId: 'attempt-1', leaseToken: 'lease-1' };
const status = {
  stateRevision: 1,
  stageRevision: 2,
  currentSubtask: 'W9-A-01',
  currentStage: 'code-review',
  execution: { activeJobId: 'job-1', activeAttemptId: 'attempt-1', activeLeaseToken: 'lease-1' },
  subtasks: { 'W9-A-01': { codeRound: 1 } },
};
const job = { subtaskId: 'W9-A-01', stage: 'code-review', round: 1, expectedStageRevision: 2 };

describe('V3 Phase 2 workflow core', () => {
  it('binds a pure check result to cursor and AttemptRef without mutating source status', () => {
    const before = structuredClone(status);
    const result = evaluateStageCheck({
      status, attempt, job,
      evaluate(snapshot) {
        snapshot.transient = true;
        return {
          pass: true,
          stageCursor: { subtaskId: 'W9-A-01', stage: 'code-review', round: 1, stageRevision: 2, activeAttemptId: 'attempt-1' },
          attemptRef: attempt,
          primarySnapshot: { sha256: 'abc', size: 3 },
        };
      },
    });
    assert.equal(result.pass, true);
    assert.deepEqual(status, before);
  });

  it('derives a transition without persisting or mutating source status', () => {
    const before = structuredClone(status);
    const transition = deriveAdvanceTransition({
      status, attempt, job,
      evaluation: { pass: true, primarySnapshot: { sha256: 'abc', size: 3 } },
      derive(snapshot) {
        snapshot.currentStage = 'delivery';
        return { nextStatus: snapshot, postCursor: { stage: 'delivery' } };
      },
    });
    assert.equal(transition.nextStatus.currentStage, 'delivery');
    assert.deepEqual(status, before);
  });
});
