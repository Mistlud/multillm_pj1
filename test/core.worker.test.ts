import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError, RoomStore, WorkerManager, type ParticipantAdapter } from "../src/core/index.js";

function makeStore(limits: Record<string, number> = {}) { return RoomStore.open({ path: ":memory:", limits, tokenCounter: (text) => text.length }); }

async function setup() {
  const db = makeStore(); const room = db.createRoom({ name: "room" });
  const participant = db.addParticipant({ roomId: room.id, displayName: "A", modelId: "fake" });
  return { db, room, participant };
}

test("input block rechecks locally after an actual model-input setting changes", async () => {
  const db = makeStore({ outputReserveTokens: 0 }); const room = db.createRoom({ name: "room" });
  const participant = db.addParticipant({ roomId: room.id, displayName: "A", modelId: "fake" });
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "hello" });
  let calls = 0;
  const manager = new WorkerManager(db, { adapters: () => ({ inputBudget: { maxInputTokens: 1, outputReserveTokens: 0, countInputTokens: ({ input }) => input.systemPrompt === "allowed" ? 0 : 2 }, run: async () => { calls += 1; return { action: { action: "wait" } }; } }) });
  await manager.pollNow(participant.id); await manager.pollNow(participant.id);
  assert.equal(calls, 0);
  assert.equal(db.getParticipant(participant.id)!.runtime.status, "input_blocked");
  db.updateParticipant(participant.id, { systemPrompt: "allowed" });
  await manager.pollNow(participant.id);
  assert.equal(calls, 1);
  db.close();
});

test("read_post is constrained to the cycle's initial post high-water mark", async () => {
  const { db, room, participant } = await setup();
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "start" });
  let observedToolContent: unknown = "not called";
  const adapter: ParticipantAdapter = { run: async ({ history }) => {
    if (!history.length) {
      const post = db.appendPostWithReference({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, title: "late", body: "late body", message: "late ref" }).post;
      return { action: { action: "read_post", postId: post.id } };
    }
    observedToolContent = history[0]!.content;
    return { action: { action: "wait" } };
  } };
  await new WorkerManager(db, { adapters: () => adapter }).pollNow(participant.id);
  assert.equal(observedToolContent, null);
  db.close();
});

test("permanent adapter errors survive restart and clear only on input setting change or OFF then ON", async () => {
  const { db, room, participant } = await setup();
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "first" });
  let permanent = true; let calls = 0;
  const adapter: ParticipantAdapter = { run: async () => { calls += 1; if (permanent) throw new AdapterError("credential rejected", { permanent: true }); return { action: { action: "wait" } }; } };
  const first = new WorkerManager(db, { adapters: () => adapter });
  await first.pollNow(participant.id);
  assert.equal(db.getParticipant(participant.id)!.runtime.permanentError, true);
  await new WorkerManager(db, { adapters: () => adapter }).pollNow(participant.id);
  assert.equal(calls, 1);

  permanent = false; db.updateParticipant(participant.id, { systemPrompt: "changed" });
  await new WorkerManager(db, { adapters: () => adapter }).pollNow(participant.id);
  assert.equal(db.getParticipant(participant.id)!.runtime.permanentError, false);

  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "second" }); permanent = true;
  await new WorkerManager(db, { adapters: () => adapter }).pollNow(participant.id);
  const reset = new WorkerManager(db, { adapters: () => adapter });
  reset.setEnabled(participant.id, false); reset.setEnabled(participant.id, true); permanent = false;
  await reset.pollNow(participant.id);
  assert.equal(db.getParticipant(participant.id)!.runtime.permanentError, false);
  db.close();
});

test("empty and self-only current threads make zero adapter calls", async () => {
  const { db, room, participant } = await setup(); let calls = 0;
  const manager = new WorkerManager(db, { adapters: () => ({ run: async () => { calls += 1; return { action: { action: "wait" } }; } }) });
  await manager.pollNow(participant.id);
  db.appendRes({ roomId: room.id, author: { type: "participant", id: participant.id, displayName: "A" }, body: "self" });
  await manager.pollNow(participant.id);
  assert.equal(calls, 0);
  db.close();
});

test("per-participant claim is single-flight and wait advances observed snapshot", async () => {
  const { db, room, participant } = await setup(); let calls = 0; let release: (() => void) | undefined;
  const adapter: ParticipantAdapter = { run: async () => { calls += 1; await new Promise<void>((resolve) => { release = resolve; }); return { action: { action: "wait", memo: "seen" } }; } };
  const manager = new WorkerManager(db, { adapters: () => adapter });
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "hello" });
  const first = manager.pollNow(participant.id); const second = manager.pollNow(participant.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release?.(); await Promise.all([first, second]);
  const after = db.getParticipant(participant.id)!;
  assert.equal(after.privateMemo, "seen");
  assert.deepEqual(after.runtime.observed, { threadId: db.getCurrentThread(room.id)!.id, resNumber: 1 });
  db.close();
});

test("OFF preserves a running cycle result but server stop rejects late output and a new run can retry", async () => {
  const { db, room, participant } = await setup();
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "hello" });
  let resolveFirst: ((value: { action: unknown }) => void) | undefined;
  const firstAdapter: ParticipantAdapter = { run: () => new Promise((resolve) => { resolveFirst = resolve; }) };
  const manager = new WorkerManager(db, { adapters: () => firstAdapter });
  const inFlight = manager.pollNow(participant.id); await new Promise((resolve) => setImmediate(resolve));
  manager.setEnabled(participant.id, false);
  resolveFirst?.({ action: { action: "reply", message: "finished despite off" } }); await inFlight;
  assert.equal(db.listThreadRes(db.getCurrentThread(room.id)!.id).at(-1)?.body, "finished despite off");
  assert.equal(db.getParticipant(participant.id)!.runtime.status, "off");

  db.updateParticipant(participant.id, { enabled: true });
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "again" });
  let resolveLate: ((value: { action: unknown }) => void) | undefined;
  const stopping = new WorkerManager(db, { adapters: () => ({ run: () => new Promise((resolve) => { resolveLate = resolve; }) }) });
  const late = stopping.pollNow(participant.id); await new Promise((resolve) => setImmediate(resolve));
  stopping.stop(); await late;
  assert.equal(db.listThreadRes(db.getCurrentThread(room.id)!.id).some((res) => res.body === "must not persist"), false);
  resolveLate?.({ action: { action: "reply", message: "must not persist" } });
  const restarted = new WorkerManager(db, { adapters: () => ({ run: async () => ({ action: { action: "wait" } }) }) });
  await restarted.pollNow(participant.id);
  assert.equal(db.getParticipant(participant.id)!.runtime.status, "idle");
  db.close();
});
