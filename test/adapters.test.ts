import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialStore } from '../src/server/credentials.js';
import { createAdapterResolver, buildPrompts } from '../src/adapters/index.js';
import { RoomStore, WorkerManager } from '../src/core/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('compatible adapter sends sanitized stateless actions, measures usage, respects rate limits', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-adapter-')); const db = RoomStore.open({ path: ':memory:' });
  const room = db.createRoom({ name: 'test' });
  const connection = db.addConnection({ name: 'private-backend-name', type: 'oai-compatible', config: { endpoint: 'http://localhost:9999/v1', contextTokens: 64000 } });
  const participant = db.addParticipant({ roomId: room.id, displayName: '앨리스', modelId: 'private-model', connectionId: connection.id });
  const original = globalThis.fetch; let sent: any;
  try {
    globalThis.fetch = async (_url, options) => { sent = JSON.parse(String(options?.body)); return new Response(JSON.stringify({ id: 'request1', choices: [{ message: { content: '{"action":"wait","memo":"기억"}' } }], usage: { prompt_tokens: 42, completion_tokens: 4 } }), { headers: { 'Content-Type': 'application/json' } }); };
    db.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: '관리자' }, body: '대화 내용' });
    const workers = new WorkerManager(db, { adapters: createAdapterResolver(new CredentialStore(dataDir)) });
    await workers.pollNow(participant.id);
    assert.equal(db.getParticipant(participant.id)!.privateMemo, '기억');
    assert.equal(db.getUsageSummary().inputTokens, 42);
    assert.equal(sent.messages.length, 2);
    assert.equal(sent.messages[1].content.includes('private-model'), false);
    assert.equal(sent.messages[1].content.includes('private-backend-name'), false);
    globalThis.fetch = async () => new Response('', { status: 429, headers: { 'Retry-After': '300' } });
    db.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: '관리자' }, body: '추가 내용' });
    await workers.pollNow(participant.id);
    assert.equal(db.getParticipant(participant.id)!.runtime.status, 'error');
    assert.equal(db.getUsageSummary().calls, 2);
    workers.stop();
  } finally { globalThis.fetch = original; db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
