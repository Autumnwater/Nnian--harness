import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalHash, resolveInsideRoot, sha256Text } from '../scripts/file-protocol.js';
import {
  MailboxStore,
  activeCursorHash,
  createMailboxStageCursor,
  validateMailboxRecord,
} from '../scripts/mailbox-store.js';

const makeStore = (options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mailbox-'));
  const harnessRoot = path.join(root, 'Harness');
  const reviewRoot = path.join(root, 'review');
  fs.mkdirSync(path.join(harnessRoot, 'runs', 'W9-A'), { recursive: true });
  const promptDir = path.join(harnessRoot, 'runs', 'W9-A', 'prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, 'prompt.md');
  fs.writeFileSync(promptPath, 'prompt', 'utf8');
  fs.mkdirSync(path.join(reviewRoot, 'W9', 'W9-A-01'), { recursive: true });
  return {
    root,
    harnessRoot,
    reviewRoot,
    promptPath,
    promptHash: sha256Text('prompt'),
    outputPath: path.join(reviewRoot, 'W9', 'W9-A-01', 'report.md'),
    store: new MailboxStore({ harnessRoot, reviewRoot, taskId: 'W9-A', ...options }),
  };
};

const cursorInput = {
  subtaskId: 'W9-A-01',
  stage: 'code-fix',
  round: 1,
  stageRevision: 3,
};

const createCursor = (sessionId, attemptId) =>
  createMailboxStageCursor({ ...cursorInput, activeSessionId: sessionId, activeAttemptId: attemptId });

const makeSession = (ledger, promptPath = '/tmp/prompt.md', promptHash = 'sha256:prompt') => ({
  protocolVersion: 1,
  kind: 'hexai.mailbox.session',
  taskId: ledger.taskId,
  sessionId: ledger.sessionId,
  attemptId: ledger.attemptId,
  state: 'published',
  stageCursor: ledger.stageCursor,
  activeCursorHash: ledger.activeCursorHash,
  bindingId: null,
  promptPath,
  promptSha256: promptHash,
  primaryReportPath: '/tmp/report.md',
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
  closedAt: null,
  lastEventId: null,
});

const makeEnvelope = (ledger, outputPath, promptPath = '/tmp/prompt.md', promptHash = 'sha256:prompt') => ({
  protocolVersion: 1,
  kind: 'hexai.mailbox.task',
  taskId: ledger.taskId,
  sessionId: ledger.sessionId,
  attemptId: ledger.attemptId,
  createdAt: '2026-06-21T00:00:00.000Z',
  role: 'work',
  expectedSkill: 'nNian-code-fix',
  stageCursor: ledger.stageCursor,
  activeCursorHash: ledger.activeCursorHash,
  prompt: {
    path: promptPath,
    sha256: promptHash,
  },
  expectedOutput: {
    primaryReportPath: outputPath,
    baseline: { exists: false, size: 0, mtimeMs: 0, sha256: '' },
  },
  constraints: {
    noAutoApprove: true,
    noAutoDelivery: true,
    noCommit: true,
    noPush: true,
    noClipboard: true,
    noWarp: true,
  },
});

const publishThroughEnvelope = ({ store, outputPath, promptPath, promptHash }) => {
  const ledger = store.createPublishIntent({
    stageCursor: cursorInput,
    statusRevisionBefore: 11,
    sessionId: 'session-1',
    attemptId: 'attempt-1',
    publishOperationId: 'publish-1',
  });
  store.markPromptWritten(ledger.sessionId, promptHash);
  store.markSessionWritten(ledger.sessionId, makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));
  return store.markEnvelopePublished(ledger.sessionId, makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, promptPath, promptHash), outputPath);
};

const publishCommittedSession = fixture => {
  const ledger = publishThroughEnvelope(fixture);
  fixture.store.markStatusActive(ledger.sessionId, { statusRevisionAfter: 12 });
  fixture.store.commitPublish(ledger.sessionId, '2026-06-21T00:00:00.000Z');
  return fixture.store.readPublishLedger(ledger.sessionId);
};

describe('Phase B mailbox file protocol and store', () => {
  it('validates mailbox schemas and rejects schema-unknown session states', () => {
    const cursor = createCursor('session-1', 'attempt-1');
    const session = makeSession({
      taskId: 'W9-A',
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      stageCursor: cursor,
      activeCursorHash: activeCursorHash(cursor),
    });

    assert.equal(validateMailboxRecord('hexai.mailbox.session', session), session);
    assert.throws(
      () => validateMailboxRecord('hexai.mailbox.session', { ...session, state: 'abandoned-closed' }),
      /invalid-session-state/
    );
  });

  it('rejects unknown fields on every mailbox record kind', () => {
    const { store, outputPath, promptPath, promptHash } = makeStore();
    const binding = store.createBinding({ bindingId: 'claude.work.local', role: 'work' }).binding;
    const ledger = publishCommittedSession({ store, outputPath, promptPath, promptHash });
    const session = store.readSession(ledger.sessionId);
    const committed = store.assertPublishCommitted(ledger.sessionId).marker;
    const close = store.createCloseIntent({
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      activeCursorHash: ledger.activeCursorHash,
      terminalPreconditionState: 'check-passed',
      closeOperationId: 'close-1',
    });

    for (const [kind, record] of [
      ['hexai.mailbox.binding', binding],
      ['hexai.mailbox.session', session],
      ['hexai.mailbox.publish-ledger', ledger],
      ['hexai.mailbox.publish-committed', committed],
      ['hexai.mailbox.close-ledger', close],
    ]) {
      assert.throws(
        () => validateMailboxRecord(kind, { ...record, unexpectedField: true }),
        /unknown-fields/
      );
    }
  });

  it('keeps mailbox records under the independent mailbox subtree', () => {
    const { harnessRoot, store } = makeStore();
    store.createBinding({ bindingId: 'claude.work.local', role: 'work' });

    assert.ok(fs.existsSync(path.join(harnessRoot, 'runs', 'W9-A', 'mailbox', 'bindings', 'claude.work.local.json')));
    assert.equal(fs.existsSync(path.join(harnessRoot, 'runs', 'W9-A', 'bindings', 'claude.work.local.json')), false);
  });

  it('atomically preserves the previous session record when a write crashes before rename', () => {
    let crash = false;
    const { store } = makeStore({
      faultInjector(point) {
        if (crash && point === 'before-file-rename') throw new Error('injected-crash');
      },
    });
    const cursor = createCursor('session-1', 'attempt-1');
    const session = makeSession({
      taskId: 'W9-A',
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      stageCursor: cursor,
      activeCursorHash: activeCursorHash(cursor),
    });

    store.writeSession(session);
    crash = true;

    assert.throws(() => store.writeSession({ ...session, state: 'running' }), /injected-crash/);
    assert.equal(store.readSession('session-1').state, 'published');
  });

  it('splits stable publish operationHash from post-artifact publishContentHash', () => {
    const { store, outputPath, promptPath, promptHash } = makeStore();
    const intent = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });

    store.markPromptWritten(intent.sessionId, promptHash);
    let ledger = store.readPublishLedger(intent.sessionId);
    assert.equal(ledger.operationHash, intent.operationHash);
    assert.equal(ledger.publishContentHash, null);

    store.markSessionWritten(intent.sessionId, makeSession(ledger, promptPath, promptHash));
    ledger = store.markEnvelopePublished(
      intent.sessionId,
      makeEnvelope(store.readPublishLedger(intent.sessionId), outputPath, promptPath, promptHash),
      outputPath
    );

    assert.equal(ledger.operationHash, intent.operationHash);
    assert.match(ledger.publishContentHash, /^sha256:/);
    assert.match(ledger.expectedOutputPathHash, /^sha256:/);

    assert.throws(
      () => store.writePublishLedger({ ...ledger, promptHash: 'sha256:replaced-prompt' }),
      /publish-content-hash-mismatch/
    );
    assert.throws(
      () => store.writePublishLedger({ ...ledger, phase: 'prompt-written', publishContentHash: null }),
      /publish-phase-rollback|publish-content-collision/
    );
  });

  it('commits publish only when operation and content hashes match the marker', () => {
    const { store, outputPath, promptPath, promptHash } = makeStore();
    const ledger = publishThroughEnvelope({ store, outputPath, promptPath, promptHash });
    store.markStatusActive(ledger.sessionId, { statusRevisionAfter: 12 });

    assert.throws(() => store.assertPublishCommitted(ledger.sessionId), /publish-not-committed/);
    const marker = store.commitPublish(ledger.sessionId, '2026-06-21T00:00:00.000Z');

    assert.equal(marker.operationHash, store.readPublishLedger(ledger.sessionId).operationHash);
    assert.equal(marker.publishContentHash, store.readPublishLedger(ledger.sessionId).publishContentHash);
    assert.deepEqual(store.assertPublishCommitted(ledger.sessionId).marker, marker);
  });

  it('reuses an existing publish committed marker when retrying with a different committedAt', () => {
    const { store, outputPath, promptPath, promptHash } = makeStore();
    const ledger = publishThroughEnvelope({ store, outputPath, promptPath, promptHash });
    store.markStatusActive(ledger.sessionId, { statusRevisionAfter: 12 });

    const first = store.commitPublish(ledger.sessionId, '2026-06-21T00:00:00.000Z');
    const second = store.commitPublish(ledger.sessionId, '2026-06-21T00:00:01.000Z');

    assert.deepEqual(second, first);
    assert.equal(second.committedAt, '2026-06-21T00:00:00.000Z');
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'committed');
    assert.equal(store.readPublishLedger(ledger.sessionId).committedAt, '2026-06-21T00:00:00.000Z');
  });

  it('fences session writes to the publish ledger attempt and cursor', () => {
    const { store, outputPath, promptPath, promptHash } = makeStore();
    const ledger = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });
    store.markPromptWritten(ledger.sessionId, promptHash);
    const current = store.readPublishLedger(ledger.sessionId);

    assert.throws(
      () => store.markSessionWritten(
        ledger.sessionId,
        { ...makeSession(current, promptPath, promptHash), attemptId: 'wrong-attempt' }
      ),
      /session-attempt-mismatch/
    );
    assert.equal(store.readSession(ledger.sessionId), null);
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'prompt-written');

    assert.throws(
      () => store.markSessionWritten(
        ledger.sessionId,
        {
          ...makeSession(current, promptPath, promptHash),
          stageCursor: { ...current.stageCursor, stageRevision: 4 },
        }
      ),
      /session-stage-cursor-mismatch/
    );
    assert.equal(store.readSession(ledger.sessionId), null);
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'prompt-written');

    store.markSessionWritten(ledger.sessionId, makeSession(current, promptPath, promptHash));
    const published = store.markEnvelopePublished(
      ledger.sessionId,
      makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, promptPath, promptHash),
      outputPath
    );
    assert.equal(published.phase, 'envelope-published');
  });

  it('fences envelope publication to the publish ledger session, attempt, and cursor', () => {
    const { store, outputPath, promptPath, promptHash } = makeStore();
    const ledger = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });
    store.markPromptWritten(ledger.sessionId, promptHash);
    store.markSessionWritten(ledger.sessionId, makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));
    const current = store.readPublishLedger(ledger.sessionId);
    const wrongCursor = createCursor('session-2', 'attempt-2');

    assert.throws(
      () => store.writeEnvelope(makeEnvelope(current, outputPath, promptPath, promptHash), outputPath),
      /unfenced-envelope-write/
    );

    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        {
          ...makeEnvelope(current, outputPath, promptPath, promptHash),
          sessionId: 'session-2',
          attemptId: 'attempt-2',
          stageCursor: wrongCursor,
          activeCursorHash: activeCursorHash(wrongCursor),
        },
        outputPath
      ),
      /envelope-session-mismatch/
    );
    assert.equal(store.readEnvelope(ledger.sessionId), null);
    assert.equal(store.readEnvelope('session-2'), null);
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'session-written');

    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        { ...makeEnvelope(current, outputPath, promptPath, promptHash), attemptId: 'wrong-attempt' },
        outputPath
      ),
      /envelope-attempt-mismatch/
    );
    assert.equal(store.readEnvelope(ledger.sessionId), null);
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'session-written');

    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        {
          ...makeEnvelope(current, outputPath, promptPath, promptHash),
          stageCursor: { ...current.stageCursor, stageRevision: 4 },
        },
        outputPath
      ),
      /envelope-stage-cursor-mismatch/
    );
    assert.equal(store.readEnvelope(ledger.sessionId), null);
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'session-written');

    const published = store.markEnvelopePublished(
      ledger.sessionId,
      makeEnvelope(current, outputPath, promptPath, promptHash),
      outputPath
    );
    assert.equal(published.phase, 'envelope-published');
    assert.ok(store.readEnvelope(ledger.sessionId));
  });

  it('requires session-written phase and matching session record before publishing envelope', () => {
    const { store, outputPath, promptPath, promptHash } = makeStore();
    const ledger = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });

    store.markPromptWritten(ledger.sessionId, promptHash);
    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, promptPath, promptHash),
        outputPath
      ),
      /publish-phase-conflict: expected session-written, got prompt-written/
    );
    assert.equal(store.readSession(ledger.sessionId), null);
    assert.equal(store.readEnvelope(ledger.sessionId), null);
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'prompt-written');

    store.markSessionWritten(ledger.sessionId, makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));
    fs.rmSync(store.sessionPath(ledger.sessionId));
    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, promptPath, promptHash),
        outputPath
      ),
      /session-record-not-found/
    );
    assert.equal(store.readEnvelope(ledger.sessionId), null);
    assert.equal(store.readPublishLedger(ledger.sessionId).phase, 'session-written');

    store.writeSession(makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));
    const published = store.markEnvelopePublished(
      ledger.sessionId,
      makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, promptPath, promptHash),
      outputPath
    );
    assert.equal(published.phase, 'envelope-published');
  });

  it('rejects output path symlink escapes before computing publishContentHash', () => {
    const { root, reviewRoot, store, promptPath, promptHash } = makeStore();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(reviewRoot, 'W9', 'W9-A-01', 'escape'));
    const escapedOutput = path.join(reviewRoot, 'W9', 'W9-A-01', 'escape', 'report.md');
    const ledger = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });

    store.markPromptWritten(ledger.sessionId, promptHash);
    store.markSessionWritten(ledger.sessionId, makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));

    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        makeEnvelope(store.readPublishLedger(ledger.sessionId), escapedOutput, promptPath, promptHash),
        escapedOutput
      ),
      /path-outside-allowlist/
    );
    assert.throws(() => resolveInsideRoot(escapedOutput, reviewRoot, { allowMissingLeaf: true }), /path-outside-allowlist/);
  });

  it('validates envelope paths before writing the inbox envelope', () => {
    const { root, reviewRoot, outputPath, promptPath, promptHash, store } = makeStore();
    const otherSubtaskDir = path.join(reviewRoot, 'W9', 'W9-A-02');
    fs.mkdirSync(otherSubtaskDir, { recursive: true });
    const unsafeOutput = path.join(otherSubtaskDir, 'report.md');
    const unsafePrompt = path.join(root, 'unsafe-prompt.md');
    fs.writeFileSync(unsafePrompt, 'prompt', 'utf8');
    const ledger = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });

    store.markPromptWritten(ledger.sessionId, promptHash);
    store.markSessionWritten(ledger.sessionId, makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));

    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        makeEnvelope(store.readPublishLedger(ledger.sessionId), unsafeOutput, promptPath, promptHash),
        outputPath
      ),
      /path-outside-allowlist|envelope-output-path-mismatch/
    );
    assert.equal(store.readEnvelope(ledger.sessionId), null);

    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, unsafePrompt, promptHash),
        outputPath
      ),
      /path-outside-allowlist/
    );
    assert.equal(store.readEnvelope(ledger.sessionId), null);
  });

  it('does not create output parents through review-root symlink escapes', () => {
    const { root, reviewRoot, outputPath, promptPath, promptHash, store } = makeStore();
    const outside = path.join(root, 'outside-review-week');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(reviewRoot, 'W9'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(reviewRoot, 'W9'));
    const ledger = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });

    store.markPromptWritten(ledger.sessionId, promptHash);
    store.markSessionWritten(ledger.sessionId, makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));

    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, promptPath, promptHash),
        outputPath
      ),
      /path-outside-allowlist/
    );
    assert.equal(fs.existsSync(path.join(outside, 'W9-A-01')), false);
    assert.equal(store.readEnvelope(ledger.sessionId), null);
  });

  it('rejects mailbox receipt directory symlink escapes before creating nested parents', () => {
    const fixture = makeStore();
    const { root, store } = fixture;
    store.createBinding({ bindingId: 'claude.work.local', role: 'work' });
    const ledger = publishCommittedSession(fixture);
    const outside = path.join(root, 'outside-receipts');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, store.paths.receipts);
    const input = {
      bindingId: 'claude.work.local',
      role: 'work',
      kind: 'session.completed',
      eventId: 'event-1',
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      occurredAt: '2026-06-21T00:00:00.000Z',
      stageCursor: ledger.stageCursor,
      activeCursorHash: ledger.activeCursorHash,
      details: { summary: 'report written' },
    };

    assert.throws(() => store.publishReceipt(input), /path-outside-allowlist/);
    assert.equal(fs.existsSync(path.join(outside, 'inbox')), false);
  });

  it('binds envelope prompt hashes to the publish ledger and current prompt file', () => {
    const { outputPath, promptPath, promptHash, store } = makeStore();
    const ledger = store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });

    store.markPromptWritten(ledger.sessionId, promptHash);
    store.markSessionWritten(ledger.sessionId, makeSession(store.readPublishLedger(ledger.sessionId), promptPath, promptHash));
    assert.throws(
      () => store.markEnvelopePublished(
        ledger.sessionId,
        makeEnvelope(store.readPublishLedger(ledger.sessionId), outputPath, promptPath, 'sha256:wrong'),
        outputPath
      ),
      /envelope-prompt-hash-mismatch/
    );
    assert.equal(store.readEnvelope(ledger.sessionId), null);

    const tampered = makeStore();
    const tamperedLedger = tampered.store.createPublishIntent({
      stageCursor: cursorInput,
      statusRevisionBefore: 11,
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      publishOperationId: 'publish-1',
    });
    const declaredHash = tampered.promptHash;
    tampered.store.markPromptWritten(tamperedLedger.sessionId, declaredHash);
    tampered.store.markSessionWritten(
      tamperedLedger.sessionId,
      makeSession(tampered.store.readPublishLedger(tamperedLedger.sessionId), tampered.promptPath, declaredHash)
    );
    fs.writeFileSync(tampered.promptPath, 'changed prompt', 'utf8');
    assert.throws(
      () => tampered.store.markEnvelopePublished(
        tamperedLedger.sessionId,
        makeEnvelope(tampered.store.readPublishLedger(tamperedLedger.sessionId), tampered.outputPath, tampered.promptPath, declaredHash),
        tampered.outputPath
      ),
      /prompt-file-hash-mismatch/
    );
    assert.equal(tampered.store.readEnvelope(tamperedLedger.sessionId), null);
  });

  it('creates binding secrets with 0600 mode and recovers missing nonce only by replace', () => {
    const fixture = makeStore();
    const { store } = fixture;
    const created = store.createBinding({ bindingId: 'claude.work.local', role: 'work' });
    const ledger = publishCommittedSession(fixture);
    const secretPath = store.bindingSecretPath('claude.work.local');

    assert.equal((fs.statSync(secretPath).mode & 0o777), 0o600);
    assert.equal(store.readBinding('claude.work.local').sessionNonceHash, sha256Text(created.rawNonce));
    fs.rmSync(secretPath);

    assert.throws(() => store.createBinding({ bindingId: 'claude.work.local', role: 'work' }), /binding-already-live/);
    assert.throws(
      () => store.publishReceipt({
        bindingId: 'claude.work.local',
        role: 'work',
        kind: 'session.completed',
        eventId: 'event-1',
        sessionId: ledger.sessionId,
        attemptId: ledger.attemptId,
        stageCursor: ledger.stageCursor,
        activeCursorHash: ledger.activeCursorHash,
      }),
      /binding-secret-missing-or-mismatch/
    );

    const replaced = store.createBinding({ bindingId: 'claude.work.local', role: 'work', replace: true });
    assert.equal(replaced.binding.bindingGeneration, 2);
    const archived = JSON.parse(fs.readFileSync(store.replacedBindingPath('claude.work.local', 1), 'utf8'));
    assert.equal(archived.state, 'replaced');
    assert.equal(archived.bindingGeneration, 1);
  });

  it('rejects binding writes when binding directories escape through symlinks', () => {
    const escapedBindings = makeStore();
    fs.mkdirSync(escapedBindings.store.paths.mailboxRoot, { recursive: true });
    const outsideBindings = path.join(escapedBindings.root, 'outside-bindings');
    fs.mkdirSync(outsideBindings);
    fs.symlinkSync(outsideBindings, escapedBindings.store.paths.bindings);

    assert.throws(
      () => escapedBindings.store.createBinding({ bindingId: 'claude.work.local', role: 'work' }),
      /path-outside-allowlist/
    );

    const escapedSecrets = makeStore();
    fs.mkdirSync(escapedSecrets.store.paths.bindings, { recursive: true });
    const outsideSecrets = path.join(escapedSecrets.root, 'outside-secrets');
    fs.mkdirSync(outsideSecrets);
    fs.symlinkSync(outsideSecrets, escapedSecrets.store.paths.bindingSecrets);

    assert.throws(
      () => escapedSecrets.store.createBinding({ bindingId: 'claude.work.local', role: 'work' }),
      /path-outside-allowlist/
    );
    assert.equal(escapedSecrets.store.readBinding('claude.work.local'), null);
  });

  it('fails closed when persisted mailbox records contain unknown fields or corrupt kinds', () => {
    const fixture = makeStore();
    const { store } = fixture;
    const binding = store.createBinding({ bindingId: 'claude.work.local', role: 'work' }).binding;
    const ledger = publishCommittedSession(fixture);
    const session = store.readSession(ledger.sessionId);
    const marker = store.assertPublishCommitted(ledger.sessionId).marker;
    const close = store.createCloseIntent({
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      activeCursorHash: ledger.activeCursorHash,
      terminalPreconditionState: 'check-passed',
      closeOperationId: 'close-1',
    });
    const writeRaw = (filePath, value) => fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

    writeRaw(store.bindingPath(binding.bindingId), { ...binding, unexpectedField: true });
    assert.throws(() => store.readBinding(binding.bindingId), /unknown-fields/);
    writeRaw(store.bindingPath(binding.bindingId), binding);

    writeRaw(store.sessionPath(session.sessionId), { ...session, unexpectedField: true });
    assert.throws(() => store.readSession(session.sessionId), /unknown-fields/);
    writeRaw(store.sessionPath(session.sessionId), session);

    writeRaw(store.publishLedgerPath(ledger.sessionId), { ...ledger, unexpectedField: true });
    assert.throws(() => store.readPublishLedger(ledger.sessionId), /unknown-fields/);
    writeRaw(store.publishLedgerPath(ledger.sessionId), ledger);

    writeRaw(store.publishCommittedPath(marker.sessionId), { ...marker, unexpectedField: true });
    assert.throws(() => store.assertPublishCommitted(marker.sessionId), /unknown-fields/);
    writeRaw(store.publishCommittedPath(marker.sessionId), marker);

    writeRaw(store.closeLedgerPath(close.sessionId), { ...close, kind: 'hexai.mailbox.session' });
    assert.throws(() => store.readCloseLedger(close.sessionId), /kind mismatch|unknown-fields/);
  });

  it('publishes signed receipts with store-owned sequence and rejects event id collisions', () => {
    const fixture = makeStore();
    const { store } = fixture;
    store.createBinding({ bindingId: 'claude.work.local', role: 'work' });
    const ledger = publishCommittedSession(fixture);
    const input = {
      bindingId: 'claude.work.local',
      role: 'work',
      kind: 'session.completed',
      eventId: 'event-1',
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      occurredAt: '2026-06-21T00:00:00.000Z',
      stageCursor: ledger.stageCursor,
      activeCursorHash: ledger.activeCursorHash,
      details: { summary: 'report written' },
    };

    const first = store.publishReceipt(input);
    const duplicate = store.publishReceipt(input);

    assert.equal(first.status, 'published');
    assert.equal(first.receipt.sequence, 1);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(store.verifyBindingProof('claude.work.local', first.receipt), true);
    assert.throws(() => store.publishReceipt({ ...input, details: { summary: 'changed' } }), /event-id-collision/);
    assert.throws(() => store.publishReceipt({ ...input, eventId: 'event-2', role: 'review' }), /binding-role-mismatch/);
  });

  it('rejects receipts with unknown kind, uncommitted session, or mismatched attempt/cursor', () => {
    const fixture = makeStore();
    const { store } = fixture;
    store.createBinding({ bindingId: 'claude.work.local', role: 'work' });
    const ledger = publishCommittedSession(fixture);
    const input = {
      bindingId: 'claude.work.local',
      role: 'work',
      kind: 'session.completed',
      eventId: 'event-1',
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      occurredAt: '2026-06-21T00:00:00.000Z',
      stageCursor: ledger.stageCursor,
      activeCursorHash: ledger.activeCursorHash,
      details: { summary: 'report written' },
    };
    const uncommitted = makeStore();
    uncommitted.store.createBinding({ bindingId: 'claude.work.local', role: 'work' });

    assert.throws(() => store.publishReceipt({ ...input, kind: 'session.magic' }), /invalid-receipt-kind/);
    assert.throws(() => uncommitted.store.publishReceipt(input), /publish-not-committed/);
    assert.throws(() => store.publishReceipt({ ...input, attemptId: 'attempt-2' }), /receipt-attempt-mismatch/);
    assert.throws(() => store.publishReceipt({ ...input, eventId: 'event-2', activeCursorHash: 'sha256:wrong' }), /receipt-cursor-hash-mismatch/);
    assert.throws(
      () => store.publishReceipt({ ...input, eventId: 'event-3', stageCursor: { ...ledger.stageCursor, activeAttemptId: 'attempt-2' } }),
      /receipt-stage-cursor-hash-mismatch/
    );
  });

  it('fails closed on stale receipt sequence locks until explicitly recovered', () => {
    const fixture = makeStore();
    const { store } = fixture;
    store.createBinding({ bindingId: 'claude.work.local', role: 'work' });
    const ledger = publishCommittedSession(fixture);
    const input = {
      bindingId: 'claude.work.local',
      role: 'work',
      kind: 'session.completed',
      eventId: 'event-1',
      sessionId: ledger.sessionId,
      attemptId: ledger.attemptId,
      occurredAt: '2026-06-21T00:00:00.000Z',
      stageCursor: ledger.stageCursor,
      activeCursorHash: ledger.activeCursorHash,
      details: { summary: 'report written' },
    };
    fs.mkdirSync(path.dirname(store.receiptSequenceLockPath(ledger.attemptId)), { recursive: true });
    fs.writeFileSync(store.receiptSequenceLockPath(ledger.attemptId), '{"pid":0}', 'utf8');

    assert.throws(() => store.publishReceipt(input), /receipt-sequence-lock-exists/);
    assert.equal(store.recoverReceiptSequenceLock(ledger.attemptId, { reason: 'test recovery' }).recovered, true);
    assert.equal(store.publishReceipt(input).status, 'published');
    assert.equal(store.readEvents().at(-1).kind, 'mailbox.receipt-sequence-lock-recovery');
  });

  it('recovers partial mailbox event journals and deduplicates event ids', () => {
    const { store } = makeStore();
    const event = { protocolVersion: 1, kind: 'mailbox.operator-action', eventId: 'event-1', action: 'claim' };

    assert.deepEqual(store.appendEvent(event), { appended: true, eventId: 'event-1' });
    fs.appendFileSync(store.paths.eventsFile, '{"eventId":"broken"');
    assert.equal(store.recoverEventJournal().truncated, true);
    assert.deepEqual(store.appendEvent(event), { appended: false, eventId: 'event-1' });
    assert.throws(() => store.appendEvent({ ...event, action: 'close' }), /event-id-collision/);
    assert.equal(store.readEvents().length, 1);
    assert.equal(canonicalHash(store.readEvents()[0]), canonicalHash(event));
  });

  it('quarantines role evidence failures instead of appending rejected evidence to a corrupt ledger/index path', () => {
    const fixture = makeStore();
    const { store } = fixture;
    const binding = store.createBinding({
      bindingId: 'claude.work.local',
      role: 'work',
      workerIdentityHash: 'sha256:worker-1',
    }).binding;
    const ledger = publishCommittedSession(fixture);
    const session = {
      ...store.readSession(ledger.sessionId),
      bindingId: binding.bindingId,
      claimBindingId: binding.bindingId,
      claimBindingGeneration: binding.bindingGeneration,
      claimWorkerIdentityHash: binding.workerIdentityHash,
      claimSource: 'claude-code-worker',
      claimedAt: '2026-06-21T00:00:00.000Z',
    };
    store.writeSession(session);
    store.appendClaimedRoleEvidence({ session, binding, source: 'claude-code-worker' });
    const beforeCount = store.readRoleEvidenceEvents().length;
    fs.writeFileSync(store.roleEvidenceWorkerPath(binding.workerIdentityHash), '{"broken":true}\n', 'utf8');

    assert.throws(
      () => store.assertNoOppositeRoleGateSatisfied({ session, binding, stageRole: binding.role, source: 'claude-code-worker' }),
      /role-evidence-worker-index-mismatch/
    );

    assert.equal(store.readRoleEvidenceEvents().length, beforeCount);
    assert.equal(store.readEvents().at(-1).kind, 'mailbox.role-evidence-quarantine');
  });

  it('recovers close ledger after session closed while status is already cleared', () => {
    const { store } = makeStore();
    const cursor = createCursor('session-1', 'attempt-1');
    store.writeSession({
      ...makeSession({
        taskId: 'W9-A',
        sessionId: 'session-1',
        attemptId: 'attempt-1',
        stageCursor: cursor,
        activeCursorHash: activeCursorHash(cursor),
      }),
      state: 'closed',
    });
    store.createCloseIntent({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      activeCursorHash: activeCursorHash(cursor),
      terminalPreconditionState: 'check-passed',
      closeOperationId: 'close-1',
    });
    store.advanceCloseLedger('session-1', 'session-closed');

    const recovered = store.recoverCloseAfterStatusCleared('session-1', { statusActiveSessionId: null });

    assert.equal(recovered.ledger.phase, 'close-committed');
    assert.equal(store.readCloseLedger('session-1').phase, 'close-committed');
    assert.deepEqual(store.readEvents().map(event => event.recoveryAction), ['continue-status-cleared', 'commit-close']);
    assert.equal(store.recoverCloseAfterStatusCleared('session-1', { statusActiveSessionId: null }).recovered, false);
  });

  it('rejects incompatible close ledger payloads and status-active-other-session recovery', () => {
    const { store } = makeStore();
    const cursor = createCursor('session-1', 'attempt-1');
    store.writeSession({
      ...makeSession({
        taskId: 'W9-A',
        sessionId: 'session-1',
        attemptId: 'attempt-1',
        stageCursor: cursor,
        activeCursorHash: activeCursorHash(cursor),
      }),
      state: 'closed',
    });
    const ledger = store.createCloseIntent({
      sessionId: 'session-1',
      attemptId: 'attempt-1',
      activeCursorHash: activeCursorHash(cursor),
      terminalPreconditionState: 'check-passed',
      closeOperationId: 'close-1',
    });

    assert.throws(
      () => store.writeCloseLedger({ ...ledger, closeOperationId: 'close-2' }),
      /close-payload-hash-mismatch/
    );
    store.advanceCloseLedger('session-1', 'session-closed');
    assert.throws(
      () => store.recoverCloseAfterStatusCleared('session-1', { statusActiveSessionId: 'session-2' }),
      /close-recovery-status-active-other-session/
    );
    assert.equal(store.readEvents().at(-1).recoveryAction, 'reject-mismatch');
  });
});
