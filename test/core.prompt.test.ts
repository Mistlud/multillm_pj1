import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore, WorkerManager } from '../src/core/index.js';
import { CorePromptConflictError, DEFAULT_CORE_PROMPT } from '../src/core/prompt-template.js';
import { buildPrompts, compatibleRequest, codexBaseInstructions, vertexRequest } from '../src/adapters/prompts.js';
import { createApp } from '../src/server/app.js';

test('core prompt persists across restart and hard reset without changing participant prompts', () => {
  const folder = mkdtempSync(join(tmpdir(), 'llm-core-prompt-'));
  const path = join(folder, 'room.sqlite'); let store = RoomStore.open({ path });
  try {
    const room = store.createRoom({ name: 'room' });
    const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'test', systemPrompt: 'persona', privateMemo: 'old memo', enabled: false });
    assert.equal(store.getCorePrompt(room.id), DEFAULT_CORE_PROMPT);
    const template = '\n# custom\n<tone>{slot}</tone>\n';
    store.setCorePrompt(room.id, template, DEFAULT_CORE_PROMPT);
    store.close(); store = RoomStore.open({ path });
    assert.equal(store.getCorePrompt(room.id), template);
    assert.equal(store.previewParticipant(participant.id)!.input.corePrompt, template);
    store.hardReset(room.id);
    assert.equal(store.getCorePrompt(room.id), template);
    assert.equal(store.getParticipant(participant.id)!.systemPrompt, 'persona');
    assert.equal(store.getParticipant(participant.id)!.enabled, false);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('core prompt validation and stale saves preserve settings; changed input releases errors', () => {
  const store = RoomStore.open({ path: ':memory:' });
  try {
    const room = store.createRoom({ name: 'room' });
    const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'test' });
    store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'context' });
    for (const template of ['', ' ', 'missing', '{slot}{slot}', 'x'.repeat(100000) + '{slot}']) assert.throws(() => store.setCorePrompt(room.id, template, DEFAULT_CORE_PROMPT));
    assert.equal(store.getCorePrompt(room.id), DEFAULT_CORE_PROMPT);
    const original = store.claimCycle({ participantId: participant.id, serverRunId: 'run' })!;
    store.failCycle({ cycleId: original.cycle.id, serverRunId: 'run', error: 'permanent', permanent: true });
    assert.equal(store.setCorePrompt(room.id, DEFAULT_CORE_PROMPT, DEFAULT_CORE_PROMPT), false);
    assert.equal(store.getParticipant(participant.id)!.runtime.permanentError, true);
    const first = 'first {slot}'; store.setCorePrompt(room.id, first, DEFAULT_CORE_PROMPT);
    assert.equal(store.getParticipant(participant.id)!.runtime.permanentError, false);
    assert.throws(() => store.setCorePrompt(room.id, 'stale {slot}', DEFAULT_CORE_PROMPT), CorePromptConflictError);
    assert.equal(store.getCorePrompt(room.id), first);
    const blocked = store.claimCycle({ participantId: participant.id, serverRunId: 'run' })!;
    assert.notEqual(blocked.cycle.inputSignature, original.cycle.inputSignature);
    assert.equal(blocked.cycle.inputSignature.includes(first), false);
    store.failCycle({ cycleId: blocked.cycle.id, serverRunId: 'run', status: 'input_blocked', error: 'too long' });
    assert.equal(store.claimCycle({ participantId: participant.id, serverRunId: 'run' }), null);
    const second = 'second {slot}'; store.setCorePrompt(room.id, second, first);
    const active = store.claimCycle({ participantId: participant.id, serverRunId: 'run' })!;
    assert.equal(active.input.corePrompt, second);
    store.setCorePrompt(room.id, 'third {slot}', second);
    assert.equal(store.getParticipant(participant.id)!.runtime.activeCycleId, active.cycle.id);
    store.failCycle({ cycleId: active.cycle.id, serverRunId: 'run', error: 'old permanent', permanent: true });
    assert.equal(store.getParticipant(participant.id)!.runtime.permanentError, false);
    assert.equal(store.getParticipant(participant.id)!.runtime.status, 'idle');
  } finally { store.close(); }
});

test('core prompt edits preserve all read rounds in a running cycle and affect the next cycle', async () => {
  const store = RoomStore.open({ path: ':memory:' }); let worker: WorkerManager | undefined;
  try {
    const room = store.createRoom({ name: 'room' });
    store.setCorePrompt(room.id, 'old {slot}', DEFAULT_CORE_PROMPT);
    const participant = store.addParticipant({ roomId: room.id, displayName: 'A', modelId: 'test', systemPrompt: 'persona' });
    store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'context' });
    const observed: string[] = []; let release!: (value: { action: unknown }) => void;
    worker = new WorkerManager(store, { adapters: () => ({ run: async (request) => {
      observed.push(buildPrompts(request).system);
      if (observed.length === 1) return new Promise((resolve) => { release = resolve; });
      return { action: { action: 'wait', memo: 'remember' } };
    } }) });
    const running = worker.pollNow(participant.id);
    const active = store.getParticipant(participant.id)!.runtime.activeCycleId;
    store.setCorePrompt(room.id, 'new {slot}', 'old {slot}'); worker.roomPromptUpdated(room.id);
    assert.equal(store.getParticipant(participant.id)!.runtime.activeCycleId, active);
    assert.equal(buildPrompts({ input: store.previewParticipant(participant.id)!.input, history: [] }).system, 'new persona');
    release({ action: { action: 'read_res', thread: 1, res: 1 } }); await running;
    assert.deepEqual(observed, ['old persona', 'old persona']);
    assert.equal(store.getParticipant(participant.id)!.privateMemo, 'remember');
    store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'next' });
    await worker.pollNow(participant.id);
    assert.deepEqual(observed, ['old persona', 'old persona', 'new persona']);
  } finally { worker?.stop(); store.close(); }
});

test('core prompt API validates and rejects stale edits; preview matches every provider without calls', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'llm-core-prompt-api-'));
  const store = RoomStore.open({ path: ':memory:' }); const token = 'local-core-prompt-test-token'.repeat(2);
  const codex = { status: () => ({ available: false, authenticated: false, busy: false }), stop: async () => {} } as any;
  const app = createApp({ dataDir: folder, token, host: '127.0.0.1', port: 4317 }, { store, codexManager: codex });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method = 'GET', data?: unknown, authenticated = true) => fetch(base + path, { method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  try {
    assert.equal((await call('/api/prompts', 'PATCH', { template: 'unauthorized {slot}', expectedTemplate: DEFAULT_CORE_PROMPT }, false)).status, 401);
    const initial = await (await call('/api/prompts')).json() as Array<{ adapter: string; text: string }>;
    const before = initial.find((item) => item.adapter === 'all')!.text;
    assert.equal(before, DEFAULT_CORE_PROMPT);
    assert.equal((await call('/api/prompts', 'PATCH', { template: 'missing', expectedTemplate: before })).status, 400);
    const template = '\ncustom\n<tone>{slot}</tone> $&';
    const savedResponse = await call('/api/prompts', 'PATCH', { template, expectedTemplate: before }); assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as Array<{ adapter: string; text: string }>;
    assert.equal(saved.find((item) => item.adapter === 'all')!.text, template);
    assert.deepEqual(saved.filter((item) => item.adapter !== 'all'), initial.filter((item) => item.adapter !== 'all'));
    assert.equal((await call('/api/prompts', 'PATCH', { template: 'stale {slot}', expectedTemplate: before })).status, 409);
    assert.equal(store.getCorePrompt(app.room.id), template);
    for (const type of ['vertex', 'oai-compatible', 'custom-api', 'codex']) {
      const connection = store.addConnection({ name: type, type, config: { contextTokens: 64000 } });
      const participant = store.addParticipant({ roomId: app.room.id, displayName: type, modelId: 'fake', connectionId: connection.id, systemPrompt: '$& {slot} literal', enabled: false });
      const snapshot = store.previewParticipant(participant.id)!;
      const request = { participant: snapshot.participant, input: snapshot.input, history: [], signal: new AbortController().signal };
      const preview = await (await call(`/api/participants/${participant.id}/preview`)).json() as any;
      const expected = type === 'vertex' ? vertexRequest(request, 4096) : type === 'codex' ? preview.transport : compatibleRequest(request, connection, 4096);
      assert.deepEqual(preview.transport, expected);
      assert.equal(preview.system, type === 'codex' ? codexBaseInstructions(request) : template.replace('{slot}', () => participant.systemPrompt));
      assert.equal(preview.fixedInstructions.find((item: any) => item.adapter === 'all').text, template);
    }
    // Unicode at the declared character limit must fit the PATCH payload including the baseline.
    const large = '가'.repeat(99994) + '{slot}';
    assert.equal((await call('/api/prompts', 'PATCH', { template: large, expectedTemplate: template })).status, 200);
    assert.equal((await call('/api/prompts', 'PATCH', { template: large + 'a', expectedTemplate: large })).status, 400);
    assert.equal((await call('/api/prompts', 'PATCH', { template, expectedTemplate: large })).status, 200);
    assert.equal(store.listCycles(app.room.id).length, 0); assert.equal(store.listUsage(app.room.id).length, 0);
  } finally { const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(folder, { recursive: true, force: true }); }
});
