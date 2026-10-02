import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RoomStore } from '../src/core/index.js';
import { createApp } from '../src/server/app.js';

test('dashboard bounds usage and cycles, keeps unknown tokens separate, and preserves historical attribution', () => {
  let now = new Date(2026, 9, 2, 10, 15).getTime();
  const store = RoomStore.open({ path: ':memory:', now: () => now });
  try {
    const room = store.createRoom({ id: 'main', name: 'dashboard' });
    const realConnection = store.addConnection({ name: 'Zed connection', type: 'vertex' });
    const mockConnection = store.addConnection({ name: 'removed mock', type: 'mock' });
    const otherRealConnection = store.addConnection({ name: 'other real', type: 'oai-compatible' });
    const real = store.addParticipant({ roomId: room.id, displayName: 'Zed', modelId: 'real', connectionId: realConnection.id });
    const nullTokens = store.addParticipant({ roomId: room.id, displayName: 'unknown tokens', modelId: 'real', connectionId: realConnection.id });
    const otherReal = store.addParticipant({ roomId: room.id, displayName: 'other real participant', modelId: 'real', connectionId: otherRealConnection.id });
    const mock = store.addParticipant({ roomId: room.id, displayName: 'mock participant', modelId: 'mock', connectionId: mockConnection.id });
    const unknown = store.addParticipant({ roomId: room.id, displayName: 'unknown participant', modelId: 'none', connectionId: null });
    const run = 'server';
    const unread = () => store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: `message ${now}` });

    unread(); const realCycle = store.claimCycle({ participantId: real.id, serverRunId: run })!;
    store.recordUsage({ participantId: real.id, connectionId: realConnection.id, cycleId: realCycle.cycle.id, inputTokens: 12 });
    now += 60 * 60_000;
    store.updateParticipant(real.id, { displayName: 'Amy' }); store.updateConnection(realConnection.id, { name: 'Amy connection' });
    store.recordUsage({ participantId: real.id, connectionId: realConnection.id, cycleId: realCycle.cycle.id, outputTokens: 7 });
    store.completeCycle({ cycleId: realCycle.cycle.id, serverRunId: run, action: { action: 'wait' } });
    store.updateParticipant(real.id, { displayName: 'current name must not replace usage snapshot' });

    unread(); const nullCycle = store.claimCycle({ participantId: nullTokens.id, serverRunId: run })!;
    for (let index = 0; index < 101; index += 1) store.recordUsage({ participantId: nullTokens.id, connectionId: realConnection.id, cycleId: nullCycle.cycle.id });
    store.completeCycle({ cycleId: nullCycle.cycle.id, serverRunId: run, action: { action: 'wait' } });
    // Rename only after the final request, so no newer Usage legitimately captures this name.
    store.updateConnection(realConnection.id, { name: 'current connection name must not replace usage snapshot' });

    unread(); const blocked = store.claimCycle({ participantId: real.id, serverRunId: run })!;
    store.failCycle({ cycleId: blocked.cycle.id, serverRunId: run, status: 'input_blocked', error: 'input limit' });
    unread(); const otherBlocked = store.claimCycle({ participantId: otherReal.id, serverRunId: run })!;
    store.failCycle({ cycleId: otherBlocked.cycle.id, serverRunId: run, status: 'input_blocked', error: 'input limit' });
    unread(); const mockCycle = store.claimCycle({ participantId: mock.id, serverRunId: run })!;
    store.recordUsage({ participantId: mock.id, connectionId: mockConnection.id, cycleId: mockCycle.cycle.id, inputTokens: 3, outputTokens: 2 });
    store.completeCycle({ cycleId: mockCycle.cycle.id, serverRunId: run, action: { action: 'wait' } });
    unread(); const noConnection = store.claimCycle({ participantId: unknown.id, serverRunId: run })!;
    store.failCycle({ cycleId: noConnection.cycle.id, serverRunId: run, error: 'no connection' });

    const oldNow = now; now = new Date(2026, 8, 1, 10, 15).getTime();
    const old = store.addParticipant({ roomId: room.id, displayName: 'old', modelId: 'real', connectionId: otherRealConnection.id });
    unread(); const oldCycle = store.claimCycle({ participantId: old.id, serverRunId: run })!;
    store.recordUsage({ participantId: old.id, connectionId: otherRealConnection.id, cycleId: oldCycle.cycle.id, inputTokens: 99, outputTokens: 88 });
    store.completeCycle({ cycleId: oldCycle.cycle.id, serverRunId: run, action: { action: 'wait' } });
    now = oldNow;
    const otherRoom = store.createRoom({ id: 'other', name: 'other' });
    const otherRoomParticipant = store.addParticipant({ roomId: otherRoom.id, displayName: 'other room', modelId: 'real', connectionId: otherRealConnection.id });
    store.appendRes({ roomId: otherRoom.id, author: { type: 'admin', id: null, displayName: 'admin' }, body: 'other room message' });
    const otherRoomCycle = store.claimCycle({ participantId: otherRoomParticipant.id, serverRunId: run })!;
    store.recordUsage({ participantId: otherRoomParticipant.id, connectionId: otherRealConnection.id, cycleId: otherRoomCycle.cycle.id, inputTokens: 77, outputTokens: 66 });
    store.completeCycle({ cycleId: otherRoomCycle.cycle.id, serverRunId: run, action: { action: 'wait' } });

    store.deleteParticipant(real.id); store.deleteParticipant(nullTokens.id); store.deleteConnection(realConnection.id);
    const realDashboard = store.getDashboard(room.id, { period: 'today', mode: 'real' });
    assert.deepEqual(realDashboard.totals, {
      calls: 103, inputTokens: 12, outputTokens: 7, inputKnownCalls: 1, outputKnownCalls: 1,
      cycles: { calling: 0, completed: 2, failed: 0, abandoned: 0, input_blocked: 2 }, unclassifiedCycles: 1,
    });
    assert.equal(realDashboard.buckets.length, 12);
    assert.equal(realDashboard.buckets.some((item) => item.calls === 0), true);
    const deletedReal = realDashboard.participants.find((participant) => participant.id === real.id)!;
    assert.equal(deletedReal.deleted, true);
    assert.equal(deletedReal.cycles.input_blocked, 1);
    assert.equal(deletedReal.displayName, 'Amy');
    assert.deepEqual(realDashboard.choices.connections.find((connection) => connection.id === realConnection.id), { id: realConnection.id, displayName: 'Amy connection', type: 'vertex', deleted: true });
    const nullTokenParticipant = realDashboard.participants.find((participant) => participant.id === nullTokens.id)!;
    assert.deepEqual({ calls: nullTokenParticipant.calls, inputTokens: nullTokenParticipant.inputTokens, outputTokens: nullTokenParticipant.outputTokens, inputKnownCalls: nullTokenParticipant.inputKnownCalls, outputKnownCalls: nullTokenParticipant.outputKnownCalls }, { calls: 101, inputTokens: null, outputTokens: null, inputKnownCalls: 0, outputKnownCalls: 0 });
    const filtered = store.getDashboard(room.id, { period: 'today', mode: 'real', participantId: real.id, connectionId: realConnection.id });
    assert.equal(filtered.choices.participants.some((participant) => participant.id === nullTokens.id), true);
    assert.equal(filtered.choices.connections.some((connection) => connection.id === otherRealConnection.id), true);
    assert.equal(store.getDashboard(room.id, { period: '7d', mode: 'real' }).buckets.length, 7);
    assert.equal(store.getDashboard(room.id, { period: '30d', mode: 'real' }).totals.inputTokens, 12);
    const mockDashboard = store.getDashboard(room.id, { period: 'today', mode: 'mock' });
    assert.equal(mockDashboard.totals.calls, 1);
    assert.equal(mockDashboard.totals.cycles.completed, 1);
    assert.equal(mockDashboard.totals.unclassifiedCycles, 1);
    assert.equal(store.getDashboard(room.id, { period: 'today', mode: 'real', connectionId: realConnection.id }).totals.unclassifiedCycles, 0);
    assert.throws(() => store.getDashboard(room.id, { period: 'year' as any, mode: 'real' }), /invalid dashboard period/);
  } finally { store.close(); }
});

test('dashboard route requires room authentication and validates bounded filters', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-room-dashboard-'));
  const store = RoomStore.open({ path: ':memory:' }); const token = 't'.repeat(32);
  const app = createApp({ dataDir, token, host: '127.0.0.1', port: 4317 }, { store });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const get = (path: string, authenticated = true) => fetch(base + path, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {} });
  try {
    assert.equal((await get('/api/dashboard', false)).status, 401);
    assert.equal((await get('/api/dashboard?period=year')).status, 400);
    assert.equal((await get('/api/dashboard?mode=all')).status, 400);
    assert.equal((await get('/api/dashboard?from=0')).status, 400);
    const response = await get('/api/dashboard?period=30d&mode=mock');
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.filters.period, '30d'); assert.equal(body.filters.mode, 'mock');
  } finally {
    const closed = once(app.server, 'close'); app.shutdown(); await closed; store.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});
