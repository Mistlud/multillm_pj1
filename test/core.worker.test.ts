import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError, RoomStore, WorkerManager, type ParticipantAdapter } from "../src/core/index.js";

function makeStore(limits: Record<string, number> = {}) { return RoomStore.open({ path: ":memory:", limits, tokenCounter: (text) => text.length }); }

async function setup() {
  const db = makeStore(); const room = db.createRoom({ name: "room" });
  const participant = db.addParticipant({ roomId: room.id, displayName: "A", modelId: "fake" });
  return { db, room, participant };
}

for (const sample of [
  { action: "reply", thread: 1, expectedThread: { value: 1, type: "number" }, allowedFields: ["action", "message", "memo"] },
  { action: "read_post", thread: "2", expectedThread: { value: "2", type: "string" }, allowedFields: ["action", "postId"] },
  { action: "wait", thread: { memo: "nested-private-sentinel" }, expectedThread: { value: "[non-scalar value omitted]", type: "object" }, allowedFields: ["action", "memo"] },
]) {
  test(`rejected action field diagnostics: ${sample.action}`, async () => {
    const { db, room, participant } = await setup();
    db.updateParticipant(participant.id, { privateMemo: "existing memo" });
    db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "admin" }, body: "hello" });
    const response = { action: sample.action, thread: sample.thread, message: "body-private-sentinel", memo: "memo-private-sentinel" };
    const manager = new WorkerManager(db, { adapters: () => ({ run: async () => ({ action: response, usage: { inputTokens: 12, outputTokens: 3 } }) }) });
    try {
      await manager.pollNow(participant.id);
      const error = db.listErrors(room.id)[0]!;
      const details = error.details as Record<string, unknown>;
      assert.equal(error.message, "unknown action field: thread");
      assert.equal(details.action, sample.action);
      assert.deepEqual(details.thread, sample.expectedThread);
      assert.deepEqual(details.receivedFields, Object.keys(response));
      assert.deepEqual(details.allowedFields, sample.allowedFields);
      assert.deepEqual(details.rejectedFields, Object.keys(response).filter((field) => !sample.allowedFields.includes(field)));
      const cycle = db.getCycleDetail(room.id, error.cycleId!)!;
      assert.equal(cycle.cycle.status, "failed");
      assert.equal(db.getCurrentThread(room.id)!.resCount, 1);
      assert.equal(db.getParticipant(participant.id)!.privateMemo, "existing memo");
      assert.equal(db.getParticipant(participant.id)!.runtime.observed, null);
      assert.equal(db.listUsage(room.id)[0]!.inputTokens, 12);
      const stored = JSON.stringify({ error, events: cycle.events });
      for (const sentinel of ["body-private-sentinel", "memo-private-sentinel", "nested-private-sentinel"]) assert.equal(stored.includes(sentinel), false);
    } finally { manager.stop(); db.close(); }
  });
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

test("connection budget edits recheck blocked input and keep participant identity and memo", async () => {
  const db = makeStore({ outputReserveTokens: 0 });
  const room = db.createRoom({ name: "room" });
  const connection = db.addConnection({ name: "shared", type: "fake", config: { contextTokens: 1 } });
  const participant = db.addParticipant({ roomId: room.id, displayName: "A", modelId: "fake", connectionId: connection.id, privateMemo: "keep me" });
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "hello" });
  let calls = 0;
  const manager = new WorkerManager(db, { adapters: (_participant, current) => ({ inputBudget: { maxInputTokens: Number(current!.config.contextTokens), outputReserveTokens: 0, countInputTokens: () => 2 }, run: async () => { calls++; return { action: { action: "wait" } }; } }) });
  try {
    await manager.pollNow(participant.id);
    await manager.pollNow(participant.id);
    assert.equal(calls, 0);
    assert.equal(db.getParticipant(participant.id)!.runtime.status, "input_blocked");
    db.updateConnection(connection.id, { config: { contextTokens: 1024 } });
    await manager.pollNow(participant.id);
    assert.equal(calls, 1);
    const after = db.getParticipant(participant.id)!;
    assert.equal(after.displayName, "A");
    assert.equal(after.privateMemo, "keep me");
    assert.equal(after.connectionId, connection.id);
    assert.equal(after.runtime.status, "idle");
  } finally { manager.stop(); db.close(); }
});

for (const inputBlocked of [false, true]) {
  test(`connection replacement recovers after an old in-flight ${inputBlocked ? "input-blocked" : "permanent"} error`, async () => {
    const db = makeStore(); const room = db.createRoom({ name: "room" });
    const connection = db.addConnection({ name: "shared", type: "fake", credentialRef: "old-key" });
    const participant = db.addParticipant({ roomId: room.id, displayName: "A", modelId: "fake", connectionId: connection.id, privateMemo: "keep me" });
    db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "hello" });
    let rejectOld: ((error: Error) => void) | undefined;
    const seen: string[] = [];
    const manager = new WorkerManager(db, { adapters: (_participant, current) => {
      seen.push(current!.credentialRef!);
      return { run: () => current!.credentialRef === "old-key" ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve({ action: { action: "wait" } }) };
    } });
    try {
      manager.start();
      const oldCycle = manager.pollNow(participant.id);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(seen, ["old-key"]);
      db.updateConnection(connection.id, { credentialRef: "new-key" });
      await manager.pollNow(participant.id);
      assert.deepEqual(seen, ["old-key"]);
      rejectOld!(new AdapterError("old setting rejected", { permanent: !inputBlocked, inputBlocked }));
      await oldCycle;
      const afterFailure = db.getParticipant(participant.id)!;
      assert.equal(afterFailure.runtime.permanentError, false);
      assert.notEqual(afterFailure.runtime.nextPollAt, null);
      assert.equal(afterFailure.runtime.observed, null);
      await manager.pollNow(participant.id);
      assert.deepEqual(seen, ["old-key", "new-key"]);
      assert.equal(db.getParticipant(participant.id)!.runtime.status, "idle");
      assert.equal(db.getParticipant(participant.id)!.privateMemo, "keep me");
    } finally { manager.stop(); db.close(); }
  });
}

test("connection edits leave the running cycle snapshot intact and affect the next cycle", async () => {
  const db = makeStore(); const room = db.createRoom({ name: "room" });
  const connection = db.addConnection({ name: "shared", type: "fake", credentialRef: "old-key" });
  const participant = db.addParticipant({ roomId: room.id, displayName: "A", modelId: "fake", connectionId: connection.id });
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "first" });
  let finishOld: ((value: { action: unknown }) => void) | undefined;
  const seen: string[] = [];
  const manager = new WorkerManager(db, { adapters: (_participant, current) => {
    seen.push(current!.credentialRef!);
    return { run: () => current!.credentialRef === "old-key" ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve({ action: { action: "wait" } }) };
  } });
  try {
    const oldCycle = manager.pollNow(participant.id);
    await new Promise((resolve) => setImmediate(resolve));
    db.updateConnection(connection.id, { credentialRef: "new-key" });
    db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "during generation" });
    await manager.pollNow(participant.id);
    assert.deepEqual(seen, ["old-key"]);
    finishOld!({ action: { action: "reply", message: "old result" } }); await oldCycle;
    assert.equal(db.getParticipant(participant.id)!.runtime.observed!.resNumber, 1);
    assert.equal(db.listThreadRes(db.getCurrentThread(room.id)!.id).at(-1)!.body, "old result");
    await manager.pollNow(participant.id);
    assert.deepEqual(seen, ["old-key", "new-key"]);
    assert.equal(db.getParticipant(participant.id)!.runtime.observed!.resNumber, 3);
  } finally { manager.stop(); db.close(); }
});

test("participant deletion cancels polling and prevents reactivation or scheduling after restart", async () => {
  const { db, room, participant } = await setup();
  db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "hello" });
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const cancelled = new Set<unknown>(); let calls = 0;
  const options = {
    adapters: () => ({ run: async () => { calls++; return { action: { action: "wait" } }; } }),
    setTimer: (callback: () => void, delay: number) => { const timer = { callback, delay }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => { cancelled.add(timer); },
  };
  const manager = new WorkerManager(db, options);
  let restarted: WorkerManager | undefined;
  try {
    manager.start();
    assert.equal(timers.length, 1);
    db.deleteParticipant(participant.id); manager.removeParticipant(participant.id);
    assert.equal(cancelled.has(timers[0]), true);
    timers[0]!.callback();
    await new Promise((resolve) => setImmediate(resolve));
    await manager.pollNow(participant.id);
    assert.equal(calls, 0);
    assert.equal(db.claimCycle({ participantId: participant.id, serverRunId: manager.serverRunId }), null);
    assert.throws(() => manager.setEnabled(participant.id, true), /not found/);
    assert.throws(() => db.updateParticipant(participant.id, { displayName: "revive" }), /not found/);
    manager.stop();
    restarted = new WorkerManager(db, options); restarted.start();
    assert.equal(timers.length, 1);
    assert.deepEqual(db.listParticipantsForScheduling(), []);
    assert.equal(db.getUsageSummary().calls, 0);
  } finally { restarted?.stop(); manager.stop(); db.close(); }
});
