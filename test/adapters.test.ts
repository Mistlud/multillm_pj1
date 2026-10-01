import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialStore } from '../src/server/credentials.js';
import { createAdapterResolver, buildPrompts } from '../src/adapters/index.js';
import { RoomStore, WorkerManager, validateAction } from '../src/core/index.js';
import { ACTION_SCHEMA, corePrompts, previewRequest, vertexRequest } from '../src/adapters/prompts.js';
import type { AdapterRequest } from '../src/core/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Vertex action schemas separate required and allowed fields and match actual preview', () => {
  const examples = [
    { value: { action: 'wait' }, allowed: ['action', 'memo'], required: ['action'] },
    { value: { action: 'reply', message: 'short' }, allowed: ['action', 'message', 'memo'], required: ['action', 'message'] },
    { value: { action: 'post', title: 'title', body: 'body', message: 'intro' }, allowed: ['action', 'title', 'body', 'message', 'memo'], required: ['action', 'title', 'body', 'message'] },
    { value: { action: 'read_archive', query: 'search' }, allowed: ['action', 'query'], required: ['action', 'query'] },
    { value: { action: 'read_res', thread: 1, res: 1 }, allowed: ['action', 'thread', 'res'], required: ['action', 'thread', 'res'] },
    { value: { action: 'read_range', thread: 1, from: 1, to: 10 }, allowed: ['action', 'thread', 'from', 'to'], required: ['action', 'thread', 'from', 'to'] },
    { value: { action: 'read_post', postId: 1 }, allowed: ['action', 'postId'], required: ['action', 'postId'] },
  ];
  // Vertex rejects anyOf if siblings such as type are present at the same level.
  assert.deepEqual(Object.keys(ACTION_SCHEMA), ['anyOf']);
  assert.equal(ACTION_SCHEMA.anyOf.length, examples.length);
  for (const example of examples) {
    const schema = ACTION_SCHEMA.anyOf.find((item) => item.properties.action.enum[0] === example.value.action)!;
    assert.deepEqual(Object.keys(schema.properties), example.allowed);
    assert.deepEqual(schema.required, example.required);
    assert.deepEqual(schema.propertyOrdering, example.allowed);
    assert.equal(validateAction(example.value).action, example.value.action);
  }
  // The exact observed failure remains rejected locally and is not a field in the reply schema.
  const reply = ACTION_SCHEMA.anyOf.find((item) => item.properties.action.enum[0] === 'reply')!;
  assert.equal(Object.hasOwn(reply.properties, 'to'), false);
  assert.equal(Object.hasOwn(reply.properties, 'thread'), false);
  assert.throws(() => validateAction({ action: 'reply', message: 'short', to: 1 }), /unknown action field: to/);
  assert.equal(validateAction({ action: 'wait', memo: null }).action, 'wait');
  assert.equal(validateAction({ action: 'reply', message: 'short', memo: '' }).action, 'reply');

  const store = RoomStore.open({ path: ':memory:' });
  try {
    const room = store.createRoom({ name: 'room' });
    const connection = store.addConnection({ name: 'vertex', type: 'vertex' });
    const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'gemini-3.8-flash', systemPrompt: 'custom', connectionId: connection.id });
    const request: AdapterRequest = { participant, input: store.previewParticipant(participant.id)!.input, history: [], signal: new AbortController().signal };
    const sent = vertexRequest(request, 4096);
    assert.deepEqual(sent.generationConfig.responseSchema, ACTION_SCHEMA);
    assert.deepEqual(previewRequest(request, connection).transport, sent);
    assert.deepEqual(JSON.parse(corePrompts().find((item) => item.adapter === 'vertex')!.text), ACTION_SCHEMA);
  } finally { store.close(); }
});

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
