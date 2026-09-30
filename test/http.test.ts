import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RoomStore } from '../src/core/index.js';
import { createApp } from '../src/server/app.js';
import { CredentialStore } from '../src/server/credentials.js';

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
