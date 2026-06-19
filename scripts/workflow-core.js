import { assertAttemptRef, assertStageCursor, createStageCursor } from './execution-protocol.js';

const activeAttemptRef = status => ({
  jobId: status.execution?.activeJobId || null,
  attemptId: status.execution?.activeAttemptId || null,
  leaseToken: status.execution?.activeLeaseToken || null,
});

const roundKeyForStage = stage => {
  if (['implementation-plan', 'plan-review', 'plan-fix', 'plan-fix-review'].includes(stage)) return 'planRound';
  if (['code-implementation', 'code-review', 'code-fix', 'code-fix-review'].includes(stage)) return 'codeRound';
  return 'deliveryRound';
};

const stageCursor = status => createStageCursor({
  subtaskId: status.currentSubtask,
  stage: status.currentStage,
  round: status.subtasks?.[status.currentSubtask]?.[roundKeyForStage(status.currentStage)] || 1,
  stageRevision: status.stageRevision,
  activeAttemptId: status.execution?.activeAttemptId || null,
});

export const evaluateStageCheck = ({ status, attempt, job, evaluate }) => {
  const source = structuredClone(status);
  if (attempt.lockEpoch !== source.execution?.lockEpoch) throw new Error('attempt-fence-conflict: lockEpoch');
  const expectedCursor = {
    subtaskId: job.subtaskId,
    stage: job.stage,
    round: job.round,
    stageRevision: job.expectedStageRevision,
    activeAttemptId: attempt.attemptId,
  };
  assertStageCursor(expectedCursor, stageCursor(source));
  assertAttemptRef(attempt, activeAttemptRef(source));
  const result = evaluate(structuredClone(source));
  if (!result || typeof result.pass !== 'boolean') throw new Error('workflow-check-result-invalid');
  assertStageCursor(expectedCursor, result.stageCursor);
  assertAttemptRef(attempt, result.attemptRef);
  return result;
};

export const deriveAdvanceTransition = ({ status, attempt, job, evaluation, derive }) => {
  const source = structuredClone(status);
  if (attempt.lockEpoch !== source.execution?.lockEpoch) throw new Error('attempt-fence-conflict: lockEpoch');
  assertAttemptRef(attempt, activeAttemptRef(source));
  if (!evaluation?.pass) throw new Error('workflow-check-not-passed');
  if (!evaluation.primarySnapshot?.sha256 || !Number.isInteger(evaluation.primarySnapshot.size)) {
    throw new Error('workflow-primary-evidence-invalid');
  }
  const transition = derive(structuredClone(source), evaluation);
  if (!transition?.nextStatus) throw new Error('workflow-transition-invalid');
  assertAttemptRef(attempt, activeAttemptRef(source));
  return transition;
};
