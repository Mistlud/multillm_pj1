import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RoomStore } from '../src/core/index.js';
import { createApp } from '../src/server/app.js';

function participant(store: RoomStore, roomId: string, displayName = 'participant') {
  return store.addParticipant({ roomId, displayName, modelId: 'mock', enabled: false });
}
function admin(store: RoomStore, roomId: string, body = 'admin') {
  return store.appendRes({ roomId, author: { type: 'admin', id: null, displayName: 'admin' }, body });
}
function reply(store: RoomStore, roomId: string, participantId: string, body = 'reply') {
  return store.appendRes({ roomId, author: { type: 'participant', id: participantId, displayName: 'spoofed' }, body });
}

test('notification baseline excludes admin records and treats a post introduction as one post item', () => {
  const store = RoomStore.open({ path: ':memory:' });
  try {
    const room = store.createRoom({ id: 'main', name: 'main' }); const author = participant(store, room.id, 'Alice');
    const firstAdmin = admin(store, room.id); const plain = reply(store, room.id, author.id);
    const post = store.appendPostWithReference({ roomId: room.id, author: { type: 'participant', id: author.id, displayName: 'spoofed' }, title: 'post', body: 'body', message: 'introduction' });
    const latestAdmin = admin(store, room.id, 'later admin');
    const baseline = store.getNotifications(room.id);
    assert.deepEqual(baseline.items, []); assert.equal(baseline.cursor.lastResId, latestAdmin.id);
    assert.deepEqual(store.getNotifications(room.id, { generation: baseline.cursor.generation, after: firstAdmin.id }).items, [
      { id: plain.id, kind: 'res', authorName: 'Alice' }, { id: post.res.id, kind: 'post', authorName: 'Alice' },
    ]);
    const deletedPost = store.appendPostWithReference({ roomId: room.id, author: { type: 'participant', id: author.id, displayName: 'spoofed' }, title: 'deleted', body: 'body', message: 'deleted introduction' });
    assert.equal(store.deletePost(room.id, deletedPost.post.id), true);
    assert.deepEqual(store.getNotifications(room.id, { generation: baseline.cursor.generation, after: latestAdmin.id }).items, []);
    const other = store.createRoom({ id: 'other', name: 'other' }); const otherAuthor = participant(store, other.id, 'Other'); reply(store, other.id, otherAuthor.id);
    assert.equal(store.getNotifications(room.id, { generation: baseline.cursor.generation, after: latestAdmin.id }).cursor.lastResId, deletedPost.res.id);
  } finally { store.close(); }
});

test('notification cursor spans a full old thread, excludes deleted threads, and caps the compact feed', () => {
  const store = RoomStore.open({ path: ':memory:' });
  try {
    const room = store.createRoom({ id: 'main', name: 'main' }); const author = participant(store, room.id, 'Alice');
    for (let index = 0; index < 999; index += 1) admin(store, room.id, `admin ${index}`);
    const r1000 = reply(store, room.id, author.id, 'R1000');
    assert.deepEqual({ number: store.getCurrentThread(room.id)!.number, count: store.getCurrentThread(room.id)!.resCount }, { number: 2, count: 0 });
    const cursor = store.getNotifications(room.id).cursor;
    assert.deepEqual(store.getNotifications(room.id, { generation: cursor.generation, after: r1000.id - 1 }).items, [{ id: r1000.id, kind: 'res', authorName: 'Alice' }]);

    for (let index = 0; index < 51; index += 1) reply(store, room.id, author.id, `new ${index}`);
    const capped = store.getNotifications(room.id, { generation: cursor.generation, after: r1000.id });
    assert.equal(capped.items.length, 50); assert.equal(capped.truncated, true);
    assert.equal(capped.items[0]!.id, r1000.id + 2); assert.equal(capped.items.at(-1)!.id, r1000.id + 51);
    store.forceRollover(room.id); store.deleteThreads(room.id, [2]);
    const afterDeletedThread = reply(store, room.id, author.id, 'current thread');
    const visible = store.getNotifications(room.id, { generation: cursor.generation, after: r1000.id });
    assert.equal(visible.items.some((item) => item.id === afterDeletedThread.id), true);
    assert.equal(visible.items.some((item) => item.id !== afterDeletedThread.id), false);
  } finally { store.close(); }
});

test('notification generation resets on hard reset even when Res ids are reused', () => {
  const store = RoomStore.open({ path: ':memory:' });
  try {
    const room = store.createRoom({ id: 'main', name: 'main' }); const author = participant(store, room.id, 'Alice');
    const old = reply(store, room.id, author.id, 'old'); const oldCursor = store.getNotifications(room.id).cursor;
    store.hardReset(room.id);
    const replacement = reply(store, room.id, author.id, 'replacement'); const afterReset = store.getNotifications(room.id, { generation: oldCursor.generation, after: old.id });
    assert.notEqual(afterReset.cursor.generation, oldCursor.generation);
    assert.equal(replacement.id, old.id);
    assert.deepEqual(afterReset.items, []); assert.equal(afterReset.cursor.lastResId, replacement.id);
    assert.deepEqual(store.getNotifications(room.id, { generation: afterReset.cursor.generation, after: replacement.id + 1 }).items, []);
  } finally { store.close(); }
});

test('state notification cursor requires authentication and paired valid cursor values', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-notifications-'));
  const store = RoomStore.open({ path: ':memory:' }); const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const get = (path: string, authenticated = true) => fetch(base + path, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} });
  try {
    const author = participant(store, 'main', 'Alice'); reply(store, 'main', author.id);
    assert.equal((await get('/api/state', false)).status, 401);
    const baseline = await get('/api/state'); assert.equal(baseline.status, 200);
    const notification = (await baseline.json() as any).notifications;
    assert.deepEqual(notification.items, []);
    assert.equal((await get(`/api/state?notificationGeneration=${notification.cursor.generation}`)).status, 400);
    assert.equal((await get('/api/state?notificationAfter=0')).status, 400);
    assert.equal((await get(`/api/state?notificationGeneration=${notification.cursor.generation}&notificationAfter=-1`)).status, 400);
    assert.equal((await get('/api/state?notificationGeneration=bad%20cursor&notificationAfter=0')).status, 400);
    const delta = await get(`/api/state?notificationGeneration=${notification.cursor.generation}&notificationAfter=0`);
    assert.equal(delta.status, 200); assert.equal((await delta.json() as any).notifications.items.length, 1);
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});
