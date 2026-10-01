import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore, WorkerManager } from '../src/core/index.js';
import { createAdapterResolver } from '../src/adapters/index.js';
import { registerSecret } from '../src/core/redaction.js';
import { createApp } from '../src/server/app.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { previewRequest, vertexRequest, CODEX_PREVIEW_NOTE, CODEX_DEVELOPER_INSTRUCTIONS } from '../src/adapters/prompts.js';

test('management preview is read-only, follows adapter input, and reasoning remains exact or omitted', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-management-')); const store = RoomStore.open({ path: ':memory:' }); const token = 'local-test-token-'.repeat(3); let calls = 0; let baseInstructions = ''; let turnInput = ''; let actualEffort: unknown;
  const manager = { status: () => ({ available: true, authenticated: false, busy: false }), checkStatus: async () => ({ available: true, authenticated: false, busy: false }), startLogin: async () => ({ loginUrl: 'https://auth.openai.com/fake' }), cancelLogin: async () => {}, remove: async () => {}, stop: async () => {}, openCycle: async (_connection: any, instructions: string) => { baseInstructions = instructions; return { turn: async (input: string, effort?: string) => { calls++; turnInput = input; actualEffort = effort; return { text: '{"action":"wait"}' }; }, dispose: async () => {} }; } };
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store, codexManager: manager }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const address = app.server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, method = 'GET', value?: unknown) => fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: value === undefined ? undefined : JSON.stringify(value) });
  try {
    const connection = store.addConnection({ name: 'subscription', type: 'codex', config: { contextTokens: 64000 }, credentialRef: 'internal-ref' }); const response = await call('/api/participants', 'POST', { displayName: 'A', modelId: 'explicit-model', connectionId: connection.id, modelOptions: { reasoningEffort: 'extra high' }, systemPrompt: 'custom prompt' }); assert.equal(response.status, 201); const participant = await response.json() as any;
    store.appendRes({ roomId: app.room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'context' }); const before = JSON.stringify(store.getParticipant(participant.id)?.runtime); const preview = await (await call(`/api/participants/${participant.id}/preview`)).json() as any;
    assert.equal(calls, 0); assert.equal(store.listCycles(app.room.id).length, 0); assert.equal(store.listUsage(app.room.id).length, 0); assert.equal(JSON.stringify(store.getParticipant(participant.id)?.runtime), before); assert.equal(preview.note, CODEX_PREVIEW_NOTE); assert.equal(JSON.stringify(preview).includes('internal-ref'), false); assert.equal(JSON.stringify(preview).includes(token), false);
    const snapshot = store.previewParticipant(participant.id)!; const request = { participant: snapshot.participant, input: snapshot.input, history: [], signal: new AbortController().signal }; const adapter = new CodexAdapter(connection, manager); await adapter.run(request); await adapter.dispose(); assert.equal(baseInstructions, preview.transport.thread.baseInstructions); assert.equal(turnInput, preview.transport.turn.input[0].text); assert.equal(actualEffort, 'extra high'); assert.ok(baseInstructions.includes('<tone_and_speech>\ncustom prompt\n</tone_and_speech>')); assert.ok(baseInstructions.endsWith(CODEX_DEVELOPER_INSTRUCTIONS));
    request.participant.modelOptions = { reasoningEffort: '' }; const emptyAdapter = new CodexAdapter(connection, manager); await emptyAdapter.run(request); await emptyAdapter.dispose(); assert.equal(actualEffort, undefined); assert.equal('effort' in (previewRequest(request, connection).transport as any).turn, false);
    request.participant.modelOptions = { thinkingLevel: 'max' }; assert.equal(vertexRequest(request, 4096).generationConfig.thinkingConfig.thinkingLevel, 'max'); request.participant.modelOptions = { thinkingLevel: '' }; assert.deepEqual(vertexRequest(request, 4096).generationConfig.thinkingConfig, { includeThoughts: false });
    assert.equal((await call('/api/reset', 'POST', { confirmation: 'wrong' })).status, 400); assert.equal(store.getCurrentThread(app.room.id)?.resCount, 1); assert.ok(store.listErrors(app.room.id).length > 0); assert.equal((await call('/api/reset', 'POST', { confirmation: 'HARD RESET' })).status, 200); assert.equal(store.getCurrentThread(app.room.id)?.number, 1); assert.equal(store.getCurrentThread(app.room.id)?.resCount, 0); assert.ok(store.listErrors(app.room.id).length > 0);
  } finally { const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('provider errors keep the actual code/message, redact credentials, and do not invent usage', async () => {
  const store = RoomStore.open({ path: ':memory:' }); const room = store.createRoom({ name: 'room' }); const secret = 'test-provider-secret-24680'; registerSecret(secret); const connection = store.addConnection({ name: 'backend', type: 'oai-compatible', config: { endpoint: 'https://fake.invalid/v1', contextTokens: 64000 }, credentialRef: 'fake-ref' }); const participant = store.addParticipant({ roomId: room.id, displayName: 'A', connectionId: connection.id, modelId: 'test' }); store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'trigger' });
  const originalFetch = globalThis.fetch; let sent: any;
  try { globalThis.fetch = async (_url, options) => { sent = JSON.parse(String(options?.body)); return new Response(JSON.stringify({ error: { message: `actual provider failure ${secret}`, code: 'INVALID_PARAMETER', access_token: secret } }), { status: 400 }); }; const workers = new WorkerManager(store, { adapters: createAdapterResolver({ read: async () => secret } as any) }); await workers.pollNow(participant.id);
    const error = store.listErrors(room.id)[0]!; assert.equal(error.httpStatus, 400); assert.equal(error.providerCode, 'INVALID_PARAMETER'); assert.ok(error.message.startsWith('actual provider failure')); assert.equal(JSON.stringify(store.listErrors(room.id)).includes(secret), false); assert.equal(JSON.stringify(store.listCycles(room.id)).includes(secret), false); assert.equal(store.getUsageDetails(room.id).participants[0]?.inputTokens, null); assert.equal(store.listUsage(room.id)[0]?.outputTokens, null); assert.equal('reasoning_effort' in sent, false); workers.stop();
  } finally { globalThis.fetch = originalFetch; store.close(); }
});
