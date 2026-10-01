import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomStore, WorkerManager } from '../src/core/index.js';
import { registerSecret } from '../src/core/redaction.js';

function createStore() { return RoomStore.open({ path: ':memory:', tokenCounter: (text) => text.length }); }

test('preview is read-only and thread tombstones redact archive content', () => {
  const store = createStore(); const room = store.createRoom({ name: 'room' }); const connection = store.addConnection({ name: 'mock', type: 'mock' }); const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'mock', connectionId: connection.id, systemPrompt: 'user prompt', privateMemo: 'memo' });
  store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'needle' });
  const preview = store.previewParticipant(participant.id); assert.equal(preview?.input.systemPrompt, 'user prompt'); assert.equal(preview?.input.privateMemo, 'memo'); assert.equal(store.getParticipant(participant.id)?.runtime.activeCycleId, null);
  store.forceRollover(room.id); assert.equal(store.searchArchive(room.id, 'needle').length, 1); assert.equal(store.deleteThreads(room.id, [1]), 1); assert.equal(store.searchArchive(room.id, 'needle').length, 0); assert.equal(store.readRes(room.id, 1, 1)?.body, '관리자에 의해 삭제된 불판입니다.'); store.close();
});

test('usage preserves call-time snapshots and provider-null aggregates', () => {
  const store = createStore(); const room = store.createRoom({ name: 'room' }); const connection = store.addConnection({ name: 'Mock at call', type: 'mock' }); const participant = store.addParticipant({ roomId: room.id, displayName: 'name at call', modelId: 'mock', connectionId: connection.id });
  store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'hello' }); const claim = store.claimCycle({ participantId: participant.id, serverRunId: 'run' })!;
  const usage = store.recordUsage({ participantId: participant.id, connectionId: connection.id, cycleId: claim.cycle.id, providerUsage: { simulated: true } }); store.completeCycle({ cycleId: claim.cycle.id, serverRunId: 'run', action: { action: 'wait' } }); store.updateParticipant(participant.id, { displayName: 'renamed' });
  assert.equal(store.listUsage(room.id)[0]?.participantName, 'name at call'); assert.equal(store.listUsage(room.id)[0]?.connectionName, 'Mock at call'); const details = store.getUsageDetails(room.id); assert.equal(details.participants[0]?.inputTokens, null); assert.equal(details.connections[0]?.simulated, true); assert.equal(usage.reasoningTokens, null); store.close();
});

test('hard reset keeps participant settings and errors but removes room history', () => {
  const store = createStore(); const room = store.createRoom({ name: 'room' }); const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'mock', systemPrompt: 'keep', privateMemo: 'forget' }); store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'old' }); store.recordError({ roomId: room.id, source: 'test', participantId: null, connectionId: null, cycleId: null, httpStatus: null, providerCode: null, message: 'keep error', details: null });
  const current = store.hardReset(room.id); assert.equal(current.number, 1); assert.equal(current.resCount, 0); assert.equal(store.getParticipant(participant.id)?.systemPrompt, 'keep'); assert.equal(store.getParticipant(participant.id)?.privateMemo, ''); assert.equal(store.listErrors(room.id).length, 1); store.close();
});

test('post tombstone preserves references and memo; reset removes posts and error blocks', () => {
  const store = createStore(); const room = store.createRoom({ name: 'room' }); const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'test', privateMemo: 'remember' });
  const { post, res } = store.appendPostWithReference({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, title: 'secret title', body: 'old body', message: 'ref' });
  assert.equal(store.deletePost(room.id, post.id), true); assert.equal(store.readPost(room.id, post.id)?.body, '관리자에 의해 삭제된 게시글입니다.'); assert.equal(store.readPost(room.id, post.id)?.title.includes('secret'), false); assert.equal(store.readRes(room.id, 1, res.number)?.body.includes(`>>P${post.id}`), true); assert.equal(store.getParticipant(participant.id)?.privateMemo, 'remember');
  const claim = store.claimCycle({ participantId: participant.id, serverRunId: 'test' })!; store.failCycle({ cycleId: claim.cycle.id, serverRunId: 'test', error: 'blocked', permanent: true }); store.hardReset(room.id);
  assert.equal(store.listPosts(room.id).length, 0); assert.equal(store.listCycles(room.id).length, 0); assert.equal(store.getParticipant(participant.id)?.runtime.permanentError, false); assert.equal(store.getParticipant(participant.id)?.runtime.lastError, null); store.close();
});

test('hard reset rejects an uncooperative late response without restoring errors, usage or events', async () => {
  const store = createStore(); const room = store.createRoom({ name: 'room' }); const connection = store.addConnection({ name: 'mock', type: 'mock' }); const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'test', connectionId: connection.id }); store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'old' });
  let release!: (value: any) => void; const workers = new WorkerManager(store, { adapters: () => ({ run: () => new Promise((resolve) => { release = resolve; }) }) }); const polling = workers.pollNow(participant.id); assert.equal(store.listUsage(room.id).length, 1);
  workers.hardReset(room.id); await polling; release({ action: { action: 'reply', message: 'late', memo: 'old memo' }, usage: { inputTokens: 99 } }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getCurrentThread(room.id)?.resCount, 0); assert.equal(store.getParticipant(participant.id)?.privateMemo, ''); assert.equal(store.listCycles(room.id).length, 0); assert.equal(store.listUsage(room.id).length, 0); assert.equal(store.listErrors(room.id).length, 0); workers.stop(); store.close();
});

test('same snapshot cycles keep their own result references and WAIT has no generated res', () => {
  const store = createStore(); const room = store.createRoom({ name: 'room' }); const a = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'test' }); const b = store.addParticipant({ roomId: room.id, displayName: 'B', modelId: 'test' }); store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'old' });
  const ca = store.claimCycle({ participantId: a.id, serverRunId: 'test' })!; const cb = store.claimCycle({ participantId: b.id, serverRunId: 'test' })!; store.forceRollover(room.id); const result = store.completeCycle({ cycleId: ca.cycle.id, serverRunId: 'test', action: { action: 'reply', message: 'new thread' } }); store.completeCycle({ cycleId: cb.cycle.id, serverRunId: 'test', action: { action: 'wait' } });
  assert.equal(result?.res?.threadNumber, 2); assert.equal(store.getCycleDetail(room.id, ca.cycle.id)?.result?.resId, result?.res?.id); assert.equal(store.getCycleDetail(room.id, cb.cycle.id)?.result?.resId, null); store.close();
});

test('errors retain useful provider detail while redacting registered secrets and private fields', () => {
  const store = createStore(); const room = store.createRoom({ name: 'room' }); const secret = 'credential-sentinel-987654'; registerSecret(secret); store.recordError({ roomId: room.id, source: 'provider', participantId: null, connectionId: null, cycleId: null, httpStatus: 400, providerCode: 'INVALID_ARGUMENT', message: `bad effort ${secret}`, details: { error: { message: 'unsupported max', code: 400 }, access_token: secret } });
  const stored = JSON.stringify(store.listErrors(room.id)); assert.equal(stored.includes(secret), false); assert.equal(stored.includes('unsupported max'), true); assert.equal(stored.includes('INVALID_ARGUMENT'), true); store.close();
});

test('fallback archive search excludes deleted bodies and searches body rather than author', () => {
  const store = createStore(); (store as any).hasFts5 = false; const room = store.createRoom({ name: 'room' }); store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'authorword' }, body: 'needle body' }); store.forceRollover(room.id);
  assert.equal(store.searchArchive(room.id, 'needle').length, 1); assert.equal(store.searchArchive(room.id, 'authorword').length, 0); store.deleteThreads(room.id, [1]); assert.equal(store.searchArchive(room.id, 'needle').length, 0); assert.equal(store.readRange(room.id, 1, 1, 1)[0]?.body, '관리자에 의해 삭제된 불판입니다.'); store.close();
});
