import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RoomStore } from '../src/core/index.js';
import { createApp } from '../src/server/app.js';
import { CredentialStore } from '../src/server/credentials.js';

test('codex connections accept subscription settings and reject API credentials', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-codex-api-'));
  const store = RoomStore.open({ path: ':memory:' });
  const token = 't'.repeat(32);
  const codexCalls: string[] = [];
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store, codexManager: {
    status: () => ({ available: true, authenticated: false, busy: false }),
    checkStatus: async () => ({ available: true, authenticated: false, busy: false }),
    startLogin: async (connection) => { codexCalls.push(`login:${connection.id}`); return { loginUrl: 'https://auth.openai.com/authorize?fake=1' }; },
    cancelLogin: async (id) => { codexCalls.push(`cancel:${id}`); },
    remove: async (connection) => { codexCalls.push(`remove:${connection.id}`); },
    stop: async () => {}, openCycle: async () => { throw new Error('HTTP tests must never call a model'); },
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method: string, value?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: value === undefined ? undefined : JSON.stringify(value) });
  try {
    assert.equal((await call('/api/connections', 'POST', { name: 'subscription', type: 'codex', credential: 'fake-api-key' })).status, 400);
    assert.equal(store.listConnections().length, 0);
    const created = await call('/api/connections', 'POST', { name: 'subscription', type: 'codex', config: { contextTokens: 64000, endpoint: 'https://never-use.example', apiKey: 'never-store', ephemeral: false } });
    assert.equal(created.status, 201);
    const connection = await created.json() as any;
    assert.equal(connection.type, 'codex');
    assert.deepEqual(connection.config, { contextTokens: 64000 });
    assert.equal(connection.hasCredential, false);
    assert.equal(store.getConnection(connection.id)!.credentialRef, null);
    assert.equal((await call(`/api/connections/${connection.id}`, 'PATCH', { credential: 'fake-api-key' })).status, 400);
    assert.equal((await call(`/api/connections/${connection.id}`, 'PATCH', { config: { contextTokens: 1 } })).status, 400);
    assert.equal((await call(`/api/connections/${connection.id}`, 'PATCH', { config: { contextTokens: 128000 } })).status, 200);
    assert.deepEqual(store.getConnection(connection.id)!.config, { contextTokens: 128000 });
    assert.equal((await call(`/api/connections/${connection.id}/codex/status`, 'GET', undefined, { Authorization: '' })).status, 401);
    assert.equal((await call(`/api/connections/${connection.id}/codex/login`, 'POST', {}, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await call('/api/connections/missing/codex/status', 'GET')).status, 404);
    assert.deepEqual(await (await call(`/api/connections/${connection.id}/codex/status`, 'GET')).json(), { available: true, authenticated: false, busy: false });
    assert.equal((await call(`/api/connections/${connection.id}/codex/login`, 'POST', {})).status, 200);
    assert.equal((await call(`/api/connections/${connection.id}/codex/cancel`, 'POST', {})).status, 200);
    assert.deepEqual(codexCalls, [`login:${connection.id}`, `cancel:${connection.id}`]);
    const mock = store.addConnection({ name: 'not codex', type: 'mock' });
    assert.equal((await call(`/api/connections/${mock.id}/codex/status`, 'GET')).status, 400);
    assert.equal((await call('/api/participants', 'POST', { displayName: 'bad', connectionId: connection.id, modelId: 'model', modelOptions: { outputTokens: 1024 } })).status, 400);
    const participantResponse = await call('/api/participants', 'POST', { displayName: 'Codex', connectionId: connection.id, modelId: 'gpt-6.1-sol', modelOptions: { reasoningEffort: 'medium' } });
    assert.equal(participantResponse.status, 201); const participant = await participantResponse.json() as any;
    assert.equal((await call(`/api/participants/${participant.id}`, 'PATCH', { connectionId: mock.id })).status, 400);
    assert.equal((await call(`/api/participants/${participant.id}`, 'PATCH', { connectionId: mock.id, modelOptions: {} })).status, 200);
    assert.equal((await call(`/api/connections/${connection.id}`, 'DELETE')).status, 200);
    assert.equal(codexCalls.at(-1), `remove:${connection.id}`);
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('private memo deletion only clears a deleted participant current memo', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-memo-'));
  const store = RoomStore.open({ path: join(dataDir, 'room.sqlite') });
  const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: value === undefined ? undefined : JSON.stringify(value) });
  try {
    const active = store.addParticipant({ roomId: 'main', displayName: 'current', modelId: 'mock', enabled: false, privateMemo: 'first line\nsecond line' });
    const connection = store.addConnection({ name: 'removed connection', type: 'mock' });
    const removed = store.addParticipant({ roomId: 'main', displayName: 'removed', modelId: 'mock', connectionId: connection.id, privateMemo: 'retained private memo' });
    const empty = store.addParticipant({ roomId: 'main', displayName: 'empty', modelId: 'mock', enabled: false });
    const post = store.appendPostWithReference({ roomId: 'main', author: { type: 'participant', id: removed.id, displayName: 'spoofed' }, title: 'preserved post', body: 'preserved post body', message: 'post reference' }).post;
    store.appendRes({ roomId: 'main', author: { type: 'admin', id: null, displayName: 'admin' }, body: 'cycle input' });
    const claim = store.claimCycle({ participantId: removed.id, serverRunId: app.workers.serverRunId })!;
    store.recordUsage({ participantId: removed.id, connectionId: connection.id, cycleId: claim.cycle.id, participantName: 'removed', connectionName: 'removed connection', connectionType: 'mock', inputTokens: 12, outputTokens: 8 });
    store.completeCycle({ cycleId: claim.cycle.id, serverRunId: app.workers.serverRunId, action: { action: 'wait' } });
    const before = { post: store.readPost('main', post.id), usage: store.getUsageSummary({ roomId: 'main' }), signature: store.getCycleDetail('main', claim.cycle.id)!.cycle.inputSignature };
    store.deleteParticipant(removed.id);
    store.deleteConnection(connection.id);
    store.createRoom({ id: 'other', name: 'other room' });
    const other = store.addParticipant({ roomId: 'other', displayName: 'other', modelId: 'mock', enabled: false, privateMemo: 'other room secret' });
    store.deleteParticipant(other.id);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const response = await call('/api/state');
    assert.equal(response.status, 200);
    const state = await response.json() as any;
    const memos = new Map<string, any>(state.participantMemos.map((memo: any) => [memo.participantId, memo]));
    assert.equal(memos.size, 2);
    assert.equal(memos.get(active.id).privateMemo, 'first line\nsecond line');
    assert.equal(memos.get(active.id).deletedAt, null);
    assert.equal(memos.get(empty.id).privateMemo, '');
    assert.equal(memos.has(removed.id), false);
    assert.equal(JSON.stringify(state).includes('retained private memo'), false);
    assert.equal(state.participants.some((p: any) => p.id === removed.id), false);
    assert.equal(store.listParticipantsForScheduling().some((p) => p.id === removed.id || p.id === other.id), false);
    assert.equal(JSON.stringify(state).includes('other room secret'), false);
    assert.equal((await call(`/api/participants/${removed.id}/memo`, 'DELETE', undefined, { Authorization: '' })).status, 401);
    assert.equal((await call(`/api/participants/${removed.id}/memo`, 'DELETE', undefined, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await call(`/api/participants/${active.id}/memo`, 'DELETE')).status, 409);
    assert.equal((await call(`/api/participants/${other.id}/memo`, 'DELETE')).status, 404);
    const deletedMemos = await (await call('/api/participant-memos?includeDeleted=1')).json() as any[];
    const deletedMemo = deletedMemos.find((memo) => memo.participantId === removed.id)!;
    assert.equal(deletedMemo.privateMemo, 'retained private memo');
    assert.equal(typeof deletedMemo.deletedAt, 'number');
    assert.equal(JSON.stringify(deletedMemos).includes('other room secret'), false);
    assert.equal((await call(`/api/participants/${removed.id}/memo`, 'DELETE')).status, 200);
    assert.equal(store.listParticipantMemos('main', true).find((memo) => memo.participantId === removed.id)?.privateMemo, '');
    assert.deepEqual({ post: store.readPost('main', post.id), usage: store.getUsageSummary({ roomId: 'main' }), signature: store.getCycleDetail('main', claim.cycle.id)!.cycle.inputSignature }, before);
    const usage = await (await call('/api/usage')).json() as any;
    assert.equal(usage.records[0].participantDeleted, true); assert.equal(usage.records[0].connectionDeleted, true);
    assert.equal(usage.participants.find((item: any) => item.id === removed.id).deleted, true);
    assert.equal(usage.connections.find((item: any) => item.id === connection.id).deleted, true);
    const cycles = await (await call('/api/cycles')).json() as any[];
    assert.equal(cycles.find((cycle) => cycle.id === claim.cycle.id).participantDeleted, true);
    assert.equal(cycles.find((cycle) => cycle.id === claim.cycle.id).participantName, 'removed');
    assert.deepEqual(cycles.find((cycle) => cycle.id === claim.cycle.id).connection, { id: connection.id, displayName: 'removed connection', type: 'mock', deleted: true });
    const cycleDetail = await (await call(`/api/cycles/${claim.cycle.id}`)).json() as any;
    assert.equal(cycleDetail.cycle.participantDeleted, true);
    assert.equal(cycleDetail.cycle.participantName, 'removed');
    assert.deepEqual(cycleDetail.connection, { id: connection.id, displayName: 'removed connection', type: 'mock', deleted: true });
    assert.equal('inputSignature' in cycleDetail.cycle, false);
    assert.equal(JSON.stringify(cycleDetail).includes('retained private memo'), false);
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('authenticated HTTP room, mock participant and origin protection work together', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-api-'));
  const store = RoomStore.open({ path: ':memory:' });
  const app = createApp({ dataDir, token: 't'.repeat(32), host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); app.startWorkers();
  const address = app.server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  const call = (path: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: value === undefined ? undefined : JSON.stringify(value) });
  try {
    assert.equal((await call('/api/state')).status, 401);
    const login = await call('/api/login', 'POST', { token: 't'.repeat(32) }); assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal((await call('/api/res', 'POST', { message: '안녕하세요' }, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await call('/api/res', 'POST', { message: '안녕하세요' })).status, 201);
    const connection = await (await call('/api/connections', 'POST', { name: '테스트', type: 'mock', config: {} })).json() as { id: string };
    const participant = await (await call('/api/participants', 'POST', { displayName: '앨리스', modelId: 'mock', connectionId: connection.id })).json() as { id: string };
    assert.equal((await call(`/api/participants/${participant.id}`, 'PATCH', { enabled: true })).status, 200);
    await app.workers.pollNow(participant.id);
    const state = await (await call('/api/state')).json() as any;
    assert.equal(state.messages.length, 2); assert.equal(state.messages[1].author.displayName, '앨리스'); assert.equal(state.usage.calls, 1);
    await app.workers.pollNow(participant.id);
    assert.equal(store.getUsageSummary().calls, 1);
    assert.equal((await call('/api/res', 'PATCH', { message: 'edit' })).status, 404);
    const post = await (await call('/api/posts', 'POST', { title: '긴 글', body: '자세한 설명', message: '게시판에 적었어요.' })).json() as any;
    assert.equal(post.res.body.endsWith(`>>P${post.post.id}`), true);
    assert.equal((await call(`/api/posts/${post.post.id}`)).status, 200);
    assert.equal((await call('/api/logout', 'POST', {})).status, 200);
    assert.equal((await call('/api/state')).status, 401);
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Windows DPAPI credential storage persists ciphertext and round trips without logs', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-credential-'));
  try { const store = new CredentialStore(dataDir); const id = await store.save('test-secret-한글'); assert.equal(await store.read(id), 'test-secret-한글'); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('connection edits preserve settings and recover only affected enabled participants', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-edit-'));
  const store = RoomStore.open({ path: ':memory:' });
  const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const patch = (id: string, value: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/connections/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(value) });
  try {
    const connection = store.addConnection({ name: 'shared', type: 'custom-api', config: { endpoint: 'https://old.example/v1', contextTokens: 128000, jsonMode: false }, credentialRef: 'existing-reference' });
    const roomId = 'main';
    const active = store.addParticipant({ roomId, displayName: 'on', modelId: 'test', connectionId: connection.id, enabled: true });
    const off = store.addParticipant({ roomId, displayName: 'off', modelId: 'test', connectionId: connection.id, enabled: false });
    const unrelatedConnection = store.addConnection({ name: 'other', type: 'mock' });
    const unrelated = store.addParticipant({ roomId, displayName: 'other', modelId: 'test', connectionId: unrelatedConnection.id, enabled: true });
    store.appendRes({ roomId, author: { type: 'admin', id: null, displayName: '관리자' }, body: 'unread' });
    for (const participant of [active, unrelated]) {
      const claimed = store.claimCycle({ participantId: participant.id, serverRunId: app.workers.serverRunId })!;
      store.failCycle({ cycleId: claimed.cycle.id, serverRunId: app.workers.serverRunId, permanent: true, error: 'rejected' });
    }
    app.startWorkers();
    assert.equal((await patch(connection.id, { name: 'blocked' }, { Authorization: '' })).status, 401);
    assert.equal((await patch(connection.id, { name: 'blocked' }, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await patch('missing', { name: 'none' })).status, 404);
    assert.equal((await patch(connection.id, { name: 'renamed', credential: '' })).status, 200);
    assert.equal(store.getParticipant(active.id)!.runtime.permanentError, true);
    assert.equal(store.getParticipant(active.id)!.runtime.nextPollAt, null);
    assert.equal(store.getConnection(connection.id)!.credentialRef, 'existing-reference');

    const response = await patch(connection.id, { config: { endpoint: 'https://new.example/v1', apiKey: 'never-store-in-config' } });
    assert.equal(response.status, 200);
    const safe = await response.json() as any;
    assert.equal(safe.hasCredential, true);
    assert.equal('credentialRef' in safe, false);
    assert.deepEqual(safe.config, { endpoint: 'https://new.example/v1', contextTokens: 128000, jsonMode: false });
    assert.equal(store.getParticipant(active.id)!.runtime.permanentError, false);
    assert.notEqual(store.getParticipant(active.id)!.runtime.nextPollAt, null);
    assert.equal(store.getParticipant(active.id)!.privateMemo, '');
    assert.equal(store.getParticipant(off.id)!.enabled, false);
    assert.equal(store.getParticipant(off.id)!.runtime.status, 'off');
    assert.equal(store.getParticipant(off.id)!.runtime.nextPollAt, null);
    assert.equal(store.getParticipant(unrelated.id)!.runtime.permanentError, true);
    const before = store.getConnection(connection.id)!;
    assert.equal((await patch(connection.id, { config: { contextTokens: 0 } })).status, 400);
    assert.equal((await patch(connection.id, { type: 'vertex' })).status, 400);
    assert.deepEqual(store.getConnection(connection.id), before);
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('connection credential replacement stays encrypted and invalid edits have no side effects', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-replace-'));
  const store = RoomStore.open({ path: ':memory:' });
  const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method: string, value: unknown) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
  const credentials = new CredentialStore(dataDir);
  const fileCount = () => readdirSync(join(dataDir, 'credentials')).length;
  const originalSave = CredentialStore.prototype.save;
  let releaseCredential: (() => void) | undefined;
  try {
    const created = await call('/api/connections', 'POST', { name: 'test key', type: 'custom-api', config: { endpoint: 'https://test.example/v1', contextTokens: 128000 }, credential: 'fake-original-key' });
    assert.equal(created.status, 201);
    const { id } = await created.json() as { id: string };
    const originalRef = store.getConnection(id)!.credentialRef!;
    const original = store.getConnection(id)!;
    const originalCount = fileCount();
    assert.equal((await call(`/api/connections/${id}`, 'PATCH', { name: '', credential: 'fake-invalid-key' })).status, 400);
    assert.equal((await call(`/api/connections/${id}`, 'PATCH', { config: { contextTokens: 2 }, credential: 'fake-invalid-key' })).status, 400);
    assert.deepEqual(store.getConnection(id), original);
    assert.equal(fileCount(), originalCount);
    const result = await call(`/api/connections/${id}`, 'PATCH', { credential: 'fake-replacement-key-한글' });
    assert.equal(result.status, 200);
    const responseText = await result.text();
    const replacementRef = store.getConnection(id)!.credentialRef!;
    assert.notEqual(replacementRef, originalRef);
    assert.equal(await credentials.read(replacementRef), 'fake-replacement-key-한글');
    assert.equal(responseText.includes('fake-replacement-key'), false);
    assert.equal(responseText.includes(replacementRef), false);
    assert.equal(readFileSync(join(dataDir, 'credentials', `${replacementRef}.dpapi`), 'utf8').includes('fake-replacement-key'), false);
    assert.equal(existsSync(join(dataDir, 'credentials', `${originalRef}.dpapi`)), true);
    assert.equal((await call(`/api/connections/${id}`, 'PATCH', { credential: '' })).status, 200);
    assert.equal(store.getConnection(id)!.credentialRef, replacementRef);

    const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'test@example.invalid', private_key: 'fake-private-key' });
    const vertexCreated = await call('/api/connections', 'POST', { name: 'vertex test', type: 'vertex', config: { project: 'test-project' }, credential: serviceAccount });
    assert.equal(vertexCreated.status, 201);
    const vertexId = (await vertexCreated.json() as { id: string }).id;
    const vertexRef = store.getConnection(vertexId)!.credentialRef;
    const beforeInvalid = fileCount();
    assert.equal((await call(`/api/connections/${vertexId}`, 'PATCH', { credential: '{"type":"service_account"}' })).status, 400);
    assert.equal(store.getConnection(vertexId)!.credentialRef, vertexRef);
    assert.equal(fileCount(), beforeInvalid);
    const newAccount = JSON.stringify({ type: 'service_account', client_email: 'replacement@example.invalid', private_key: 'fake-replacement-private-key' });
    assert.equal((await call(`/api/connections/${vertexId}`, 'PATCH', { credential: newAccount })).status, 200);
    assert.equal(await credentials.read(store.getConnection(vertexId)!.credentialRef!), newAccount);

    let credentialReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { credentialReady = resolve; });
    const release = new Promise<void>((resolve) => { releaseCredential = resolve; });
    CredentialStore.prototype.save = async function (secret: string): Promise<string> {
      const ref = await originalSave.call(this, secret);
      if (secret === 'fake-concurrent-key') { credentialReady!(); await release; }
      return ref;
    };
    const replacing = call(`/api/connections/${id}`, 'PATCH', { credential: 'fake-concurrent-key' });
    await ready;
    assert.equal((await call(`/api/connections/${id}`, 'PATCH', { name: 'concurrent rename', config: { endpoint: 'https://concurrent.example/v1' } })).status, 200);
    releaseCredential!();
    assert.equal((await replacing).status, 200);
    assert.equal(store.getConnection(id)!.name, 'concurrent rename');
    assert.equal(store.getConnection(id)!.config.endpoint, 'https://concurrent.example/v1');
    assert.equal(await credentials.read(store.getConnection(id)!.credentialRef!), 'fake-concurrent-key');
  } finally {
    releaseCredential?.(); CredentialStore.prototype.save = originalSave;
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('connection deletion blocks references and retains records and other active credentials', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-delete-'));
  const databasePath = join(dataDir, 'room.sqlite');
  const store = RoomStore.open({ path: databasePath }); const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const remove = (id: string, extra: Record<string, string> = {}) => fetch(`${base}/api/connections/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, ...extra } });
  const fakeCredential = () => { const ref = randomUUID(); writeFileSync(join(dataDir, 'credentials', `${ref}.dpapi`), 'inert-ciphertext-fixture'); return ref; };
  const exists = (ref: string) => existsSync(join(dataDir, 'credentials', `${ref}.dpapi`));
  try {
    const oldRef = fakeCredential(), sharedRef = fakeCredential(), currentRef = fakeCredential(), unrelatedRef = fakeCredential();
    const target = store.addConnection({ name: 'delete me', type: 'mock', credentialRef: oldRef });
    const other = store.addConnection({ name: 'keep me', type: 'mock', credentialRef: sharedRef });
    const participant = store.addParticipant({ roomId: 'main', displayName: 'A', modelId: 'mock', connectionId: target.id, enabled: false, privateMemo: 'keep memo' });
    assert.equal((await remove(target.id, { Authorization: '' })).status, 401);
    assert.equal((await remove(target.id, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await remove(target.id)).status, 409);
    assert.equal(exists(oldRef), true);
    store.updateParticipant(participant.id, { enabled: true });
    store.appendPostWithReference({ roomId: 'main', author: { type: 'admin', id: null, displayName: '관리자' }, title: 'keep post', body: 'keep body', message: 'hello' });
    const oldCycle = store.claimCycle({ participantId: participant.id, serverRunId: app.workers.serverRunId })!;
    store.updateParticipant(participant.id, { connectionId: other.id });
    assert.equal((await remove(target.id)).status, 409);
    assert.notEqual(store.getConnection(target.id), null);
    const fixtureDb = new DatabaseSync(databasePath);
    try {
      fixtureDb.prepare('UPDATE cycles SET input_signature = ? WHERE id = ?').run('', oldCycle.cycle.id);
      assert.equal((await remove(target.id)).status, 409);
      store.recordUsage({ participantId: participant.id, connectionId: target.id, cycleId: oldCycle.cycle.id, inputTokens: 12, outputTokens: 8 });
      assert.equal((await remove(target.id)).status, 409);
      fixtureDb.prepare('UPDATE cycles SET input_signature = ? WHERE id = ?').run(oldCycle.cycle.inputSignature, oldCycle.cycle.id);
    } finally { fixtureDb.close(); }
    store.completeCycle({ cycleId: oldCycle.cycle.id, serverRunId: app.workers.serverRunId, action: { action: 'reply', message: 'keep reply' } });
    store.updateConnection(target.id, { credentialRef: sharedRef });
    store.appendRes({ roomId: 'main', author: { type: 'admin', id: null, displayName: '관리자' }, body: 'another message' });
    const otherCycle = store.claimCycle({ participantId: participant.id, serverRunId: app.workers.serverRunId })!;
    store.updateConnection(other.id, { credentialRef: currentRef });
    const before = { participant: store.getParticipant(participant.id), messages: store.listThreadRes(store.getCurrentThread('main')!.id), posts: store.listPosts('main'), usage: store.getUsageSummary() };
    const deleted = await remove(target.id);
    assert.equal(deleted.status, 200);
    const result = await deleted.text();
    assert.equal(JSON.parse(result).ok, true);
    assert.equal(JSON.parse(result).cleanupWarning, false);
    assert.equal(result.includes(oldRef), false);
    assert.equal(result.includes(sharedRef), false);
    assert.equal(store.getConnection(target.id), null);
    assert.equal(exists(oldRef), false);
    assert.equal(exists(sharedRef), true);
    assert.equal(exists(currentRef), true);
    assert.equal(exists(unrelatedRef), true);
    assert.deepEqual({ participant: store.getParticipant(participant.id), messages: store.listThreadRes(store.getCurrentThread('main')!.id), posts: store.listPosts('main'), usage: store.getUsageSummary() }, before);
    const duplicateReference = store.addConnection({ name: 'unused with shared current key', type: 'mock', credentialRef: currentRef });
    assert.equal((await remove(duplicateReference.id)).status, 200);
    assert.equal(exists(currentRef), true);
    assert.equal((await remove(target.id)).status, 404);
    assert.equal((await fetch(`${base}/api/connections/${target.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'restore' }) })).status, 404);
    store.completeCycle({ cycleId: otherCycle.cycle.id, serverRunId: app.workers.serverRunId, action: { action: 'wait' } });
    const unusedRef = fakeCredential();
    const unused = store.addConnection({ name: 'unrelated to no-connection cycle', type: 'mock', credentialRef: unusedRef });
    const noConnection = store.addParticipant({ roomId: 'main', displayName: 'no connection', modelId: 'fake', connectionId: null });
    const noConnectionCycle = store.claimCycle({ participantId: noConnection.id, serverRunId: app.workers.serverRunId })!;
    assert.equal((await remove(unused.id)).status, 200);
    assert.equal(exists(unusedRef), false);
    store.completeCycle({ cycleId: noConnectionCycle.cycle.id, serverRunId: app.workers.serverRunId, action: { action: 'wait' } });
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('connection deletion reports credential cleanup failure after committing deletion', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-cleanup-'));
  const store = RoomStore.open({ path: ':memory:' }); const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const originalDelete = CredentialStore.prototype.delete;
  try {
    const ref = randomUUID(); const file = join(dataDir, 'credentials', `${ref}.dpapi`);
    writeFileSync(file, 'inert-ciphertext-fixture');
    const connection = store.addConnection({ name: 'cleanup fails', type: 'mock', credentialRef: ref });
    CredentialStore.prototype.delete = function (id: string) { if (id === ref) throw new Error('simulated file permission failure'); originalDelete.call(this, id); };
    const response = await fetch(`${base}/api/connections/${connection.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, cleanupWarning: true });
    assert.equal(store.getConnection(connection.id), null);
    assert.equal(existsSync(file), true);
  } finally {
    CredentialStore.prototype.delete = originalDelete;
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('connection deletion during a pending credential edit cleans the uncommitted key', { timeout: 15000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-delete-race-'));
  const store = RoomStore.open({ path: ':memory:' }); const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const originalSave = CredentialStore.prototype.save;
  let resumeSave: (() => void) | undefined;
  try {
    const oldRef = randomUUID(), newRef = randomUUID();
    const file = (ref: string) => join(dataDir, 'credentials', `${ref}.dpapi`);
    writeFileSync(file(oldRef), 'inert-ciphertext-fixture');
    const connection = store.addConnection({ name: 'pending edit', type: 'custom-api', config: { endpoint: 'https://test.example/v1', contextTokens: 128000 }, credentialRef: oldRef });
    let signalReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const resume = new Promise<void>((resolve) => { resumeSave = resolve; });
    CredentialStore.prototype.save = async function () { writeFileSync(file(newRef), 'inert-ciphertext-fixture'); signalReady!(); await resume; return newRef; };
    const editing = fetch(`${base}/api/connections/${connection.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: 'fake-replacement-key' }) });
    await ready;
    assert.equal((await fetch(`${base}/api/connections/${connection.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal(existsSync(file(oldRef)), false);
    resumeSave!();
    assert.equal((await editing).status, 404);
    assert.equal(store.getConnection(connection.id), null);
    assert.equal(existsSync(file(newRef)), false);
  } finally {
    resumeSave?.(); CredentialStore.prototype.save = originalSave;
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('participant deletion preserves history and releases a connection after the final participant', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-participant-delete-'));
  const databasePath = join(dataDir, 'room.sqlite');
  const store = RoomStore.open({ path: databasePath }); const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const call = (path: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: value === undefined ? undefined : JSON.stringify(value) });
  try {
    const connection = store.addConnection({ name: 'shared mock', type: 'mock' });
    const first = store.addParticipant({ roomId: 'main', displayName: 'first', modelId: 'mock', connectionId: connection.id, privateMemo: 'preserved private memo' });
    const second = store.addParticipant({ roomId: 'main', displayName: 'second', modelId: 'mock', connectionId: connection.id, enabled: false });
    store.appendPostWithReference({ roomId: 'main', author: { type: 'admin', id: null, displayName: '관리자' }, title: 'keep title', body: 'keep body', message: 'first message' });
    app.startWorkers(); await app.workers.pollNow(first.id);
    store.appendRes({ roomId: 'main', author: { type: 'admin', id: null, displayName: '관리자' }, body: 'new message' });
    const active = store.claimCycle({ participantId: first.id, serverRunId: app.workers.serverRunId })!;
    assert.equal((await call(`/api/participants/${first.id}`, 'DELETE', undefined, { Authorization: '' })).status, 401);
    assert.equal((await call(`/api/participants/${first.id}`, 'DELETE', undefined, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await call(`/api/participants/${first.id}`, 'DELETE')).status, 409);
    app.workers.setEnabled(first.id, false);
    assert.equal((await call(`/api/participants/${first.id}`, 'DELETE')).status, 409);
    assert.notEqual(store.getParticipant(first.id), null);
    store.completeCycle({ cycleId: active.cycle.id, serverRunId: app.workers.serverRunId, action: { action: 'wait' } });
    app.workers.setEnabled(first.id, true);
    assert.notEqual(store.getParticipant(first.id)!.runtime.nextPollAt, null);
    const before = { messages: store.listThreadRes(store.getCurrentThread('main')!.id), posts: store.listPosts('main'), usage: store.getUsageSummary({ roomId: 'main' }) };
    assert.equal((await call(`/api/participants/${first.id}`, 'DELETE')).status, 200);
    assert.equal(store.getParticipant(first.id), null);
    assert.deepEqual(store.listParticipants('main').map((participant) => participant.id), [second.id]);
    assert.equal(store.listParticipantsForScheduling().some((participant) => participant.id === first.id), false);
    const fixtureDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = fixtureDb.prepare('SELECT p.private_memo, p.enabled, p.connection_id, p.deleted_at, rt.next_poll_at FROM participants p JOIN participant_runtime rt ON rt.participant_id = p.id WHERE p.id = ?').get(first.id)!;
      assert.equal(row.private_memo, 'preserved private memo');
      assert.equal(row.enabled, 0); assert.equal(row.connection_id, null); assert.equal(row.next_poll_at, null);
      assert.equal(typeof row.deleted_at, 'number');
      assert.notEqual(fixtureDb.prepare('SELECT 1 FROM cycles WHERE id = ?').get(active.cycle.id), undefined);
    } finally { fixtureDb.close(); }
    assert.deepEqual({ messages: store.listThreadRes(store.getCurrentThread('main')!.id), posts: store.listPosts('main'), usage: store.getUsageSummary({ roomId: 'main' }) }, before);
    await app.workers.pollNow(first.id);
    assert.deepEqual(store.getUsageSummary({ roomId: 'main' }), before.usage);
    assert.equal((await call(`/api/participants/${first.id}`, 'PATCH', { enabled: true })).status, 404);
    assert.equal((await call(`/api/participants/${first.id}`, 'DELETE')).status, 404);
    assert.equal((await call('/api/participants/missing', 'DELETE')).status, 404);
    assert.equal((await call(`/api/connections/${connection.id}`, 'DELETE')).status, 409);
    assert.equal((await call(`/api/participants/${second.id}`, 'DELETE')).status, 200);
    assert.equal((await call(`/api/connections/${connection.id}`, 'DELETE')).status, 200);
    const state = await (await call('/api/state')).json() as any;
    assert.equal(state.participants.length, 0); assert.equal(state.connections.length, 0);
    assert.deepEqual(store.getUsageSummary({ roomId: 'main' }), before.usage);
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});
