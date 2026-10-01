import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../src/core/index.js";

function store(limits: Record<string, number> = {}) {
  return RoomStore.open({ path: ":memory:", limits, tokenCounter: (text) => text.length });
}

test("concurrent append candidates assign exact R1000 then open the next thread at R1", async () => {
  const db = store({ messageTokens: 10 });
  const room = db.createRoom({ name: "room" });
  for (let index = 0; index < 998; index += 1) db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "x" });
  const assigned = await Promise.all(["a", "b", "c"].map((body) => new Promise((resolve) => setImmediate(() => resolve(db.appendRes({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, body }))))));
  const archived = db.getThread(room.id, 1);
  const current = db.getCurrentThread(room.id);
  assert.deepEqual({ status: archived?.status, count: archived?.resCount }, { status: "closed", count: 1000 });
  assert.deepEqual((assigned as Array<{ threadNumber: number; number: number }>).map((res) => [res.threadNumber, res.number]), [[1, 999], [1, 1000], [2, 1]]);
  assert.deepEqual({ number: current?.number, count: current?.resCount, status: current?.status }, { number: 2, count: 1, status: "open" });
  db.close();
});

test("post and its final server reference roll back together when the reference exceeds the res limit", () => {
  const db = store({ messageTokens: 1, postTokens: 50 });
  const room = db.createRoom({ name: "room" });
  assert.throws(() => db.appendPostWithReference({ roomId: room.id, author: { type: "admin", id: null, displayName: "관리자" }, title: "a", body: "b", message: "x" }), /message exceeds/);
  assert.equal(db.listPosts(room.id).length, 0);
  assert.equal(db.listThreadRes(db.getCurrentThread(room.id)!.id).length, 0);
  db.close();
});

test("archive tools are room-scoped and only search closed raw threads", () => {
  const db = store({ messageTokens: 20 });
  const one = db.createRoom({ name: "one" });
  const two = db.createRoom({ name: "two" });
  for (let index = 0; index < 1000; index += 1) db.appendRes({ roomId: one.id, author: { type: "admin", id: null, displayName: "관리자" }, body: index === 0 ? "needle" : "x" });
  db.appendRes({ roomId: two.id, author: { type: "admin", id: null, displayName: "관리자" }, body: "needle" });
  assert.deepEqual(db.searchArchive(one.id, "needle").map((item) => [item.threadNumber, item.number]), [[1, 1]]);
  assert.equal(db.searchArchive(two.id, "needle").length, 0);
  assert.equal(db.readRes(two.id, 1, 1)?.body, "needle");
  db.close();
});

test("public append enforces author identity and room membership", () => {
  const db = store({ messageTokens: 20 });
  const one = db.createRoom({ name: "one" });
  const two = db.createRoom({ name: "two" });
  const participant = db.addParticipant({ roomId: one.id, displayName: "A", modelId: "fake" });
  assert.throws(() => db.appendRes({ roomId: one.id, author: { type: "admin", id: participant.id, displayName: "관리자" }, body: "x" }), /admin author id/);
  assert.throws(() => db.appendRes({ roomId: two.id, author: { type: "participant", id: participant.id, displayName: "spoofed" }, body: "x" }), /does not belong/);
  const saved = db.appendRes({ roomId: one.id, author: { type: "participant", id: participant.id, displayName: "spoofed" }, body: "x" });
  assert.equal(saved.author.displayName, "A");
  db.close();
});

test("participant deletion migration preserves legacy data and remains deleted after reopening", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "llm-room-participant-migration-"));
  const path = join(dataDir, "room.sqlite");
  let db: RoomStore | undefined;
  try {
    db = RoomStore.open({ path });
    const room = db.createRoom({ name: "legacy room" });
    const connection = db.addConnection({ name: "legacy mock", type: "mock" });
    const participant = db.addParticipant({ roomId: room.id, displayName: "legacy", modelId: "mock", connectionId: connection.id, privateMemo: "legacy memo", systemPrompt: "legacy prompt" });
    db.appendRes({ roomId: room.id, author: { type: "participant", id: participant.id, displayName: "legacy" }, body: "legacy message" });
    db.close(); db = undefined;
    const fixtureDb = new DatabaseSync(path);
    try { fixtureDb.exec("ALTER TABLE participants DROP COLUMN deleted_at"); }
    finally { fixtureDb.close(); }
    db = RoomStore.open({ path });
    const restored = db.getParticipant(participant.id)!;
    assert.equal(restored.displayName, "legacy"); assert.equal(restored.privateMemo, "legacy memo");
    assert.equal(restored.systemPrompt, "legacy prompt"); assert.equal(restored.connectionId, connection.id);
    assert.equal(db.listThreadRes(db.getCurrentThread(room.id)!.id)[0]!.body, "legacy message");
    db.deleteParticipant(participant.id); db.close(); db = undefined;
    db = RoomStore.open({ path });
    assert.equal(db.getParticipant(participant.id), null);
    assert.deepEqual(db.listParticipants(room.id), []);
    assert.deepEqual(db.listParticipantsForScheduling(), []);
    assert.equal(db.listThreadRes(db.getCurrentThread(room.id)!.id)[0]!.author.displayName, "legacy");
    assert.deepEqual(db.deleteConnection(connection.id).credentialRefsToCleanup, []);
    const auditDb = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(auditDb.prepare("SELECT private_memo FROM participants WHERE id = ?").get(participant.id)!.private_memo, "legacy memo"); }
    finally { auditDb.close(); }
  } finally { db?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
