import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { assertTokenLimit, countTokens, type TokenCounter } from "./tokens.js";
import type {
  AddConnectionInput, AddParticipantInput, AppendResInput, Connection, CoreLimits, Cursor, Cycle, CycleSnapshot,
  FinalAction, ModelInput, Participant, ParticipantDetail, ParticipantMemo, ParticipantRuntime, Post, PublicRes, Room, Thread,
  RuntimeStatus, UpdateConnectionInput, UpdateParticipantInput, UsageRecord, UsageSummary, UsageDetails, UsageAggregate, CycleDetail, CycleConnection, CycleEvent, ErrorRecord, DashboardData, DashboardMode, DashboardPeriod, DashboardChoice, DashboardCycleCounts, RoomNotifications,
} from "./types.js";
import { sanitizeError } from "./redaction.js";
import { CorePromptConflictError, DEFAULT_CORE_PROMPT, validateCorePrompt } from './prompt-template.js';

export const DEFAULT_LIMITS: CoreLimits = {
  messageTokens: 200,
  privateMemoTokens: 2000,
  postTokens: 12000,
  inputTokens: 64_000,
  outputReserveTokens: 1024,
  toolReturnTokens: 4000,
  retryBackoffMs: 120_000,
  maxToolRounds: 4,
  cycleTimeoutMs: 90_000,
  minPollMs: 60_000,
  maxPollMs: 90_000,
};

export interface RoomStoreOptions {
  path: string;
  limits?: Partial<CoreLimits>;
  tokenCounter?: TokenCounter;
  now?: () => number;
}

export interface ClaimedCycle {
  cycle: Cycle;
  participant: Participant;
  connection: Connection | null;
  input: ModelInput;
}

export interface DeletedConnection {
  credentialRefsToCleanup: string[];
}

interface SqlRow { [key: string]: unknown }

const json = (value: unknown): string => JSON.stringify(value ?? {});
const parseObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};
const connectionSignature = (value: unknown): { id: string | null; credentialRef: string | null } | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const connection = (parsed as Record<string, unknown>).connection;
    if (connection === null) return { id: null, credentialRef: null };
    if (!connection || typeof connection !== "object" || Array.isArray(connection)) return null;
    const data = connection as Record<string, unknown>;
    if (typeof data.id !== "string" || !data.id || !("credentialRef" in data) || (data.credentialRef !== null && typeof data.credentialRef !== "string")) return null;
    return { id: data.id, credentialRef: data.credentialRef as string | null };
  } catch { return null; }
};
const nullableString = (value: unknown): string | null => typeof value === "string" ? value : null;
const number = (value: unknown): number => Number(value);
const searchTerms = (text: string): string[] => [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((term) => term.length > 1))];

/** SQLite source of truth. It deliberately has no update/delete methods for public records. */
export class RoomStore {
  readonly limits: CoreLimits;
  private readonly db: DatabaseSync;
  private readonly tokens: TokenCounter;
  private readonly now: () => number;
  private hasFts5 = false;

  private constructor(options: RoomStoreOptions) {
    this.db = new DatabaseSync(options.path);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.tokens = options.tokenCounter ?? countTokens;
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  static open(options: RoomStoreOptions): RoomStore { return new RoomStore(options); }
  close(): void { this.db.close(); }

  createRoom(input: { id?: string; name: string }): Room {
    if (!input.name.trim()) throw new Error("room name is required");
    const id = input.id ?? randomUUID(); const threadId = randomUUID(); const now = this.now();
    this.transaction(() => {
      this.db.prepare("INSERT INTO rooms (id, name, current_thread_id, created_at) VALUES (?, ?, ?, ?)").run(id, input.name, threadId, now);
      this.db.prepare("INSERT INTO threads (id, room_id, number, status, res_count, created_at) VALUES (?, ?, 1, 'open', 0, ?)").run(threadId, id, now);
    });
    return { id, name: input.name, currentThreadId: threadId, createdAt: now };
  }

  getRoom(roomId: string): Room | null {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as SqlRow | undefined;
    return row ? this.mapRoom(row) : null;
  }

  getCorePrompt(roomId: string): string {
    const row = this.db.prepare('SELECT core_prompt FROM room_settings WHERE room_id = ?').get(roomId) as SqlRow | undefined;
    return row ? String(row.core_prompt) : DEFAULT_CORE_PROMPT;
  }

  /** Returns false for an unchanged template; running cycles retain their captured input. */
  setCorePrompt(roomId: string, template: string, expectedTemplate: string): boolean {
    validateCorePrompt(template);
    return this.transaction(() => {
      if (!this.getRoom(roomId)) throw new Error('room not found');
      const current = this.getCorePrompt(roomId);
      if (current !== expectedTemplate) throw new CorePromptConflictError('다른 화면에서 공통 프롬프트가 변경되었습니다. 저장된 내용을 다시 불러온 뒤 수정하세요.');
      if (current === template) return false;
      this.db.prepare('INSERT INTO room_settings (room_id, core_prompt) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET core_prompt = excluded.core_prompt').run(roomId, template);
      this.db.prepare("UPDATE participant_runtime SET permanent_error = 0, last_error = NULL, blocked_thread_id = NULL, blocked_res = NULL, blocked_input_signature = NULL, status = CASE WHEN (SELECT enabled FROM participants p WHERE p.id = participant_runtime.participant_id) = 1 THEN 'idle' ELSE 'off' END WHERE active_cycle_id IS NULL AND participant_id IN (SELECT id FROM participants WHERE room_id = ? AND deleted_at IS NULL)").run(roomId);
      return true;
    });
  }

  getCurrentThread(roomId: string): Thread | null {
    const row = this.db.prepare("SELECT t.* FROM rooms r JOIN threads t ON t.id = r.current_thread_id WHERE r.id = ?").get(roomId) as SqlRow | undefined;
    return row ? this.mapThread(row) : null;
  }

  getThread(roomId: string, threadNumber: number): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE room_id = ? AND number = ?").get(roomId, threadNumber) as SqlRow | undefined;
    return row ? this.mapThread(row) : null;
  }

  listThreads(roomId: string): Thread[] {
    return (this.db.prepare("SELECT * FROM threads WHERE room_id = ? ORDER BY number DESC").all(roomId) as SqlRow[]).map((row) => this.mapThread(row));
  }

  /** Returns participant-authored public records after an acknowledged Res id, without retaining per-client state. */
  getNotifications(roomId: string, input?: { generation: string; after: number }): RoomNotifications {
    const generationRow = this.db.prepare('SELECT id FROM threads WHERE room_id = ? AND number = 1').get(roomId) as SqlRow | undefined;
    if (!generationRow) throw new Error('room has no notification generation');
    const generation = String(generationRow.id);
    // This intentionally includes admin records and records now hidden by thread/post deletion, so a cursor always advances.
    // Seek the latest nonempty thread and its last Res through existing ordered indexes.
    const highRow = this.db.prepare('SELECT COALESCE((SELECT r.id FROM res r WHERE r.thread_id = (SELECT t.id FROM threads t WHERE t.room_id = ? AND t.res_count > 0 ORDER BY t.number DESC LIMIT 1) ORDER BY r.number DESC LIMIT 1), 0) AS id').get(roomId) as SqlRow;
    const lastResId = number(highRow.id);
    const baseline = !input || input.generation !== generation || input.after > lastResId;
    if (baseline) return { cursor: { generation, lastResId }, items: [], truncated: false };
    if (input.after === lastResId) return { cursor: { generation, lastResId }, items: [], truncated: false };
    const rows = this.db.prepare("SELECT r.id, CASE WHEN r.post_id IS NULL THEN 'res' ELSE 'post' END AS kind, r.author_display_name FROM res r JOIN threads t ON t.id = r.thread_id LEFT JOIN posts p ON p.id = r.post_id AND p.room_id = t.room_id WHERE t.room_id = ? AND r.id > ? AND r.id <= ? AND r.author_type = 'participant' AND t.deleted_at IS NULL AND (r.post_id IS NULL OR p.id IS NOT NULL AND p.deleted_at IS NULL) ORDER BY r.id DESC LIMIT 51").all(roomId, input.after, lastResId) as SqlRow[];
    return { cursor: { generation, lastResId }, items: rows.slice(0, 50).reverse().map((row) => ({ id: number(row.id), kind: String(row.kind) as 'res' | 'post', authorName: String(row.author_display_name) })), truncated: rows.length > 50 };
  }

  /** Builds exactly the app-level input used by a cycle, without reserving a cycle or changing cursors. */
  previewParticipant(participantId: string): { participant: ParticipantDetail; connection: Connection | null; input: ModelInput } | null {
    const detail = this.getParticipant(participantId); if (!detail) return null;
    const thread = this.getCurrentThread(detail.roomId); if (!thread) return null;
    return { participant: detail, connection: detail.connectionId ? this.getConnection(detail.connectionId) : null, input: this.buildModelInput(detail, thread) };
  }

  forceRollover(roomId: string): Thread {
    return this.transaction(() => {
      const thread = this.getCurrentThread(roomId); if (!thread || thread.status !== 'open') throw new Error('room has no open thread');
      const now = this.now(), id = randomUUID(); this.db.prepare("UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?").run(now, thread.id);
      this.db.prepare("INSERT INTO threads (id, room_id, number, status, res_count, created_at) VALUES (?, ?, ?, 'open', 0, ?)").run(id, roomId, thread.number + 1, now);
      this.db.prepare("UPDATE rooms SET current_thread_id = ? WHERE id = ?").run(id, roomId); return this.getCurrentThread(roomId)!;
    });
  }

  deleteThreads(roomId: string, threadNumbers: number[]): number {
    if (!threadNumbers.length) return 0;
    return this.transaction(() => { const marks = threadNumbers.filter((value) => Number.isSafeInteger(value) && value > 0); if (!marks.length) return 0; const placeholders = marks.map(() => '?').join(','); const result = this.db.prepare(`UPDATE threads SET deleted_at = ? WHERE room_id = ? AND status = 'closed' AND number IN (${placeholders}) AND deleted_at IS NULL`).run(this.now(), roomId, ...marks); return Number(result.changes); });
  }
  deletePost(roomId: string, postId: number): boolean { return this.transaction(() => Number(this.db.prepare("UPDATE posts SET deleted_at = ? WHERE room_id = ? AND id = ? AND deleted_at IS NULL").run(this.now(), roomId, postId).changes) > 0); }

  hardReset(roomId: string): Thread {
    return this.transaction(() => {
      if (!this.getRoom(roomId)) throw new Error('room not found'); const now = this.now(), id = randomUUID();
      // Trigger changes are transactional: failures restore the original protections too.
      this.db.exec('DROP TRIGGER res_is_immutable_delete; DROP TRIGGER post_is_immutable_delete;');
      this.db.prepare("DELETE FROM res_search WHERE res_id IN (SELECT r.id FROM res r JOIN threads t ON t.id = r.thread_id WHERE t.room_id = ?)").run(roomId);
      if (this.hasFts5) this.db.prepare("DELETE FROM res_fts WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM usage WHERE cycle_id IN (SELECT id FROM cycles WHERE room_id = ?)").run(roomId); this.db.prepare("DELETE FROM cycle_events WHERE cycle_id IN (SELECT id FROM cycles WHERE room_id = ?)").run(roomId); this.db.prepare("DELETE FROM cycles WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM res WHERE thread_id IN (SELECT id FROM threads WHERE room_id = ?)").run(roomId); this.db.prepare("DELETE FROM posts WHERE room_id = ?").run(roomId); this.db.prepare("DELETE FROM threads WHERE room_id = ?").run(roomId);
      this.db.exec("CREATE TRIGGER res_is_immutable_delete BEFORE DELETE ON res BEGIN SELECT RAISE(ABORT, 'res is immutable'); END; CREATE TRIGGER post_is_immutable_delete BEFORE DELETE ON posts BEGIN SELECT RAISE(ABORT, 'post is immutable'); END;");
      this.db.prepare("INSERT INTO threads (id, room_id, number, status, res_count, created_at) VALUES (?, ?, 1, 'open', 0, ?)").run(id, roomId, now); this.db.prepare("UPDATE rooms SET current_thread_id = ? WHERE id = ?").run(id, roomId);
      this.db.prepare("UPDATE participants SET private_memo = '', updated_at = ? WHERE room_id = ?").run(now, roomId); this.db.prepare("UPDATE participant_runtime SET observed_thread_id = NULL, observed_res = NULL, last_posted_thread_id = NULL, last_posted_res = NULL, active_cycle_id = NULL, next_poll_at = NULL, last_error = NULL, blocked_thread_id = NULL, blocked_res = NULL, blocked_input_signature = NULL, permanent_error = 0, status = CASE WHEN (SELECT enabled FROM participants p WHERE p.id = participant_runtime.participant_id) = 1 THEN 'idle' ELSE 'off' END WHERE participant_id IN (SELECT id FROM participants WHERE room_id = ?)").run(roomId);
      return this.getCurrentThread(roomId)!;
    });
  }

  listThreadRes(threadId: string): PublicRes[] {
    return (this.db.prepare(`${this.resSelect} WHERE r.thread_id = ? ORDER BY r.number`).all(threadId) as SqlRow[]).map((row) => this.mapRes(row));
  }

  appendRes(input: AppendResInput): PublicRes {
    this.assertMessage(input.body);
    const author = this.validateAuthor(input.roomId, input.author);
    return this.transaction(() => this.appendResInTransaction({ ...input, author }));
  }

  appendPostWithReference(input: { roomId: string; author: PublicRes["author"]; title: string; body: string; message: string; generatedFrom?: Cursor | null }): { post: Post; res: PublicRes } {
    this.assertPost(input.title, input.body);
    const author = this.validateAuthor(input.roomId, input.author);
    return this.transaction(() => {
      const now = this.now();
      const result = this.db.prepare("INSERT INTO posts (room_id, author_type, author_id, author_display_name, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.roomId, author.type, author.id, author.displayName, input.title, input.body, now);
      const postId = Number(result.lastInsertRowid);
      const finalMessage = `${input.message}\n>>P${postId}`;
      this.assertMessage(finalMessage);
      const res = this.appendResInTransaction({ roomId: input.roomId, author, body: finalMessage, generatedFrom: input.generatedFrom ?? null }, postId, now);
      return { post: { id: postId, roomId: input.roomId, author, title: input.title, body: input.body, createdAt: now, deletedAt: null }, res };
    });
  }

  listPosts(roomId: string, limit = 100): Post[] {
    return (this.db.prepare("SELECT * FROM posts WHERE room_id = ? ORDER BY id DESC LIMIT ?").all(roomId, limit) as SqlRow[]).map((row) => this.mapPost(row));
  }

  readPost(roomId: string, postId: number): Post | null {
    const row = this.db.prepare("SELECT * FROM posts WHERE room_id = ? AND id = ?").get(roomId, postId) as SqlRow | undefined;
    return row ? this.mapPost(row) : null;
  }

  readRes(roomId: string, threadNumber: number, resNumber: number): PublicRes | null {
    const row = this.db.prepare(`${this.resSelect} WHERE t.room_id = ? AND t.number = ? AND r.number = ?`).get(roomId, threadNumber, resNumber) as SqlRow | undefined;
    return row ? this.mapRes(row) : null;
  }

  readRange(roomId: string, threadNumber: number, from: number, to: number, limit = 100): PublicRes[] {
    return (this.db.prepare(`${this.resSelect} WHERE t.room_id = ? AND t.number = ? AND r.number BETWEEN ? AND ? ORDER BY r.number LIMIT ?`).all(roomId, threadNumber, from, to, limit) as SqlRow[]).map((row) => this.mapRes(row));
  }

  searchArchive(roomId: string, query: string, limit = 20): PublicRes[] {
    if (!query.trim()) return [];
    if (this.hasFts5) try {
      return (this.db.prepare(`${this.resSelect} JOIN res_fts f ON f.res_id = r.id WHERE f.body MATCH ? AND t.room_id = ? AND t.status = 'closed' AND t.deleted_at IS NULL ORDER BY rank LIMIT ?`).all(query, roomId, limit) as SqlRow[]).map((row) => this.mapRes(row));
    } catch (error) {
      throw new Error(`archive query is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const terms = searchTerms(query); if (!terms.length) return [];
    const placeholders = terms.map(() => "?").join(",");
    const bodyTerms = terms.map(() => 'instr(lower(r.body), lower(?)) > 0').join(' AND ');
    const sql = `${this.resSelect} JOIN res_search s ON s.res_id = r.id WHERE t.room_id = ? AND t.status = 'closed' AND t.deleted_at IS NULL AND s.term IN (${placeholders}) AND ${bodyTerms} GROUP BY r.id HAVING COUNT(DISTINCT s.term) = ? ORDER BY r.created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(roomId, ...terms, ...terms, terms.length, limit) as SqlRow[]).map((row) => this.mapRes(row));
  }

  addConnection(input: AddConnectionInput): Connection {
    if (!input.name.trim() || !input.type.trim()) throw new Error("connection name and type are required");
    const connection: Connection = { id: input.id ?? randomUUID(), name: input.name, type: input.type, config: input.config ?? {}, credentialRef: input.credentialRef ?? null, createdAt: this.now(), updatedAt: this.now() };
    this.db.prepare("INSERT INTO connections (id, name, type, config_json, credential_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(connection.id, connection.name, connection.type, json(connection.config), connection.credentialRef, connection.createdAt, connection.updatedAt);
    return connection;
  }

  getConnection(connectionId: string): Connection | null {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(connectionId) as SqlRow | undefined;
    return row ? this.mapConnection(row) : null;
  }

  listConnections(): Connection[] { return (this.db.prepare("SELECT * FROM connections ORDER BY name").all() as SqlRow[]).map((row) => this.mapConnection(row)); }

  updateConnection(connectionId: string, input: UpdateConnectionInput): Connection {
    const current = this.getConnection(connectionId); if (!current) throw new Error("connection not found");
    if (input.type !== undefined && input.type !== current.type) throw new Error("connection type cannot be changed");
    const next = { ...current, name: input.name ?? current.name, type: current.type, config: input.config === undefined ? current.config : { ...current.config, ...input.config }, credentialRef: input.credentialRef === undefined ? current.credentialRef : input.credentialRef, updatedAt: this.now() };
    if (!next.name.trim() || !next.type.trim()) throw new Error("connection name and type are required");
    this.transaction(() => {
      this.db.prepare("UPDATE connections SET name = ?, type = ?, config_json = ?, credential_ref = ?, updated_at = ? WHERE id = ?").run(next.name, next.type, json(next.config), next.credentialRef, next.updatedAt, connectionId);
      if (json(next.config) !== json(current.config) || next.credentialRef !== current.credentialRef) {
        this.db.prepare("UPDATE participant_runtime SET permanent_error = 0, last_error = NULL, blocked_thread_id = NULL, blocked_res = NULL, blocked_input_signature = NULL, status = CASE WHEN active_cycle_id IS NULL AND (SELECT enabled FROM participants p WHERE p.id = participant_runtime.participant_id) = 1 THEN 'idle' ELSE status END WHERE participant_id IN (SELECT id FROM participants WHERE connection_id = ?)").run(connectionId);
      }
    });
    return next;
  }

  /** Deletes only an unreferenced Connection; public records and historical usage remain immutable. */
  deleteConnection(connectionId: string): DeletedConnection {
    return this.transaction(() => {
      const current = this.getConnection(connectionId); if (!current) throw new Error("connection not found");
      if (this.db.prepare("SELECT 1 FROM participants WHERE connection_id = ? LIMIT 1").get(connectionId)) throw new Error("connection is still referenced by a participant");
      if (this.db.prepare("SELECT 1 FROM usage u JOIN cycles c ON c.id = u.cycle_id WHERE c.status = 'calling' AND u.connection_id = ? LIMIT 1").get(connectionId)) throw new Error("connection is still referenced by an active cycle");

      const candidates = new Set<string>(); if (current.credentialRef) candidates.add(current.credentialRef);
      const protectedRefs = new Set<string>();
      for (const row of this.db.prepare("SELECT status, input_signature FROM cycles").all() as SqlRow[]) {
        const signature = connectionSignature(row.input_signature);
        if (String(row.status) === "calling") {
          if (!signature) throw new Error("connection is still referenced by an active cycle");
          if (signature.id === connectionId) throw new Error("connection is still referenced by an active cycle");
          if (signature.credentialRef) protectedRefs.add(signature.credentialRef);
        } else if (signature?.id === connectionId && signature.credentialRef) candidates.add(signature.credentialRef);
      }
      for (const row of this.db.prepare("SELECT credential_ref FROM connections WHERE id <> ? AND credential_ref IS NOT NULL").all(connectionId) as SqlRow[]) {
        const ref = nullableString(row.credential_ref); if (ref) protectedRefs.add(ref);
      }
      this.db.prepare("DELETE FROM connections WHERE id = ?").run(connectionId);
      return { credentialRefsToCleanup: [...candidates].filter((ref) => !protectedRefs.has(ref)) };
    });
  }

  addParticipant(input: AddParticipantInput): ParticipantDetail {
    if (!input.displayName.trim() || !input.modelId.trim()) throw new Error("participant display name and model id are required");
    this.assertMemo(input.privateMemo ?? "");
    if (input.connectionId && !this.getConnection(input.connectionId)) throw new Error("connection not found");
    if (!this.getRoom(input.roomId)) throw new Error("room not found");
    const now = this.now(); const participant: Participant = {
      id: input.id ?? randomUUID(), roomId: input.roomId, displayName: input.displayName, avatar: input.avatar ?? null,
      enabled: input.enabled ?? true, connectionId: input.connectionId ?? null, modelId: input.modelId, modelOptions: input.modelOptions ?? {}, systemPrompt: input.systemPrompt ?? "", privateMemo: input.privateMemo ?? "", createdAt: now, updatedAt: now,
    };
    this.transaction(() => {
      this.db.prepare("INSERT INTO participants (id, room_id, display_name, avatar, enabled, connection_id, model_id, model_options_json, system_prompt, private_memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(participant.id, participant.roomId, participant.displayName, participant.avatar, Number(participant.enabled), participant.connectionId, participant.modelId, json(participant.modelOptions), participant.systemPrompt, participant.privateMemo, now, now);
      this.db.prepare("INSERT INTO participant_runtime (participant_id, status) VALUES (?, ?)").run(participant.id, participant.enabled ? "idle" : "off");
    });
    return this.requireParticipantDetail(participant.id);
  }

  getParticipant(participantId: string): ParticipantDetail | null {
    const row = this.db.prepare("SELECT p.*, rt.observed_thread_id, rt.observed_res, rt.last_posted_thread_id, rt.last_posted_res, rt.next_poll_at, rt.status, rt.active_cycle_id, rt.last_error, rt.blocked_thread_id, rt.blocked_res, rt.blocked_input_signature, rt.permanent_error FROM participants p JOIN participant_runtime rt ON rt.participant_id = p.id WHERE p.id = ? AND p.deleted_at IS NULL").get(participantId) as SqlRow | undefined;
    return row ? this.mapParticipantDetail(row) : null;
  }

  listParticipants(roomId: string): ParticipantDetail[] {
    return (this.db.prepare("SELECT p.*, rt.observed_thread_id, rt.observed_res, rt.last_posted_thread_id, rt.last_posted_res, rt.next_poll_at, rt.status, rt.active_cycle_id, rt.last_error, rt.blocked_thread_id, rt.blocked_res, rt.blocked_input_signature, rt.permanent_error FROM participants p JOIN participant_runtime rt ON rt.participant_id = p.id WHERE p.room_id = ? AND p.deleted_at IS NULL ORDER BY p.display_name").all(roomId) as SqlRow[]).map((row) => this.mapParticipantDetail(row));
  }

  /** Management-only read model; deleted memo contents require an explicit request. */
  listParticipantMemos(roomId: string, includeDeleted = false): ParticipantMemo[] {
    const deleted = includeDeleted ? "" : " AND deleted_at IS NULL";
    return (this.db.prepare(`SELECT id, display_name, private_memo, updated_at, deleted_at FROM participants WHERE room_id = ?${deleted} ORDER BY deleted_at IS NOT NULL, display_name`).all(roomId) as SqlRow[]).map((row) => ({ participantId: String(row.id), displayName: String(row.display_name), privateMemo: String(row.private_memo), updatedAt: number(row.updated_at), deletedAt: row.deleted_at === null ? null : number(row.deleted_at) }));
  }

  /** Clears only the current private memo of a soft-deleted participant; cycle snapshots remain historical records. */
  deleteDeletedParticipantMemo(roomId: string, participantId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT room_id, deleted_at FROM participants WHERE id = ?").get(participantId) as SqlRow | undefined;
      if (!row || String(row.room_id) !== roomId) throw new Error("participant not found");
      if (row.deleted_at === null || row.deleted_at === undefined) throw new Error("participant is not deleted");
      this.db.prepare("UPDATE participants SET private_memo = '', updated_at = ? WHERE id = ?").run(this.now(), participantId);
    });
  }

  /** Scheduler-only view; management metadata stays outside ModelInput. */
  listParticipantsForScheduling(): ParticipantDetail[] {
    return (this.db.prepare("SELECT p.*, rt.observed_thread_id, rt.observed_res, rt.last_posted_thread_id, rt.last_posted_res, rt.next_poll_at, rt.status, rt.active_cycle_id, rt.last_error, rt.blocked_thread_id, rt.blocked_res, rt.blocked_input_signature, rt.permanent_error FROM participants p JOIN participant_runtime rt ON rt.participant_id = p.id WHERE p.deleted_at IS NULL ORDER BY p.id").all() as SqlRow[]).map((row) => this.mapParticipantDetail(row));
  }

  updateParticipant(participantId: string, input: UpdateParticipantInput): ParticipantDetail {
    const current = this.getParticipant(participantId); if (!current) throw new Error("participant not found");
    if (input.connectionId && !this.getConnection(input.connectionId)) throw new Error("connection not found");
    const participant: Participant = {
      ...current, ...input, avatar: input.avatar === undefined ? current.avatar : input.avatar, connectionId: input.connectionId === undefined ? current.connectionId : input.connectionId,
      modelOptions: input.modelOptions ?? current.modelOptions, privateMemo: input.privateMemo ?? current.privateMemo, enabled: input.enabled ?? current.enabled, updatedAt: this.now(),
    };
    if (!participant.displayName.trim() || !participant.modelId.trim()) throw new Error("participant display name and model id are required");
    this.assertMemo(participant.privateMemo);
    this.transaction(() => {
      this.db.prepare("UPDATE participants SET display_name = ?, avatar = ?, enabled = ?, connection_id = ?, model_id = ?, model_options_json = ?, system_prompt = ?, private_memo = ?, updated_at = ? WHERE id = ?")
        .run(participant.displayName, participant.avatar, Number(participant.enabled), participant.connectionId, participant.modelId, json(participant.modelOptions), participant.systemPrompt, participant.privateMemo, participant.updatedAt, participantId);
      const inputChanged = this.inputSignature(participant) !== this.inputSignature(current);
      const explicitOffThenOn = input.enabled === true && !current.enabled;
      if (input.enabled !== undefined) {
        if (!input.enabled) this.db.prepare("UPDATE participant_runtime SET next_poll_at = NULL, status = CASE WHEN active_cycle_id IS NULL THEN 'off' ELSE status END WHERE participant_id = ?").run(participantId);
        else this.db.prepare("UPDATE participant_runtime SET status = CASE WHEN active_cycle_id IS NULL THEN 'idle' ELSE status END WHERE participant_id = ?").run(participantId);
      }
      if (inputChanged || explicitOffThenOn) this.db.prepare("UPDATE participant_runtime SET permanent_error = 0, status = CASE WHEN active_cycle_id IS NULL AND (SELECT enabled FROM participants p WHERE p.id = participant_runtime.participant_id) = 1 THEN 'idle' ELSE status END WHERE participant_id = ?").run(participantId);
    });
    return this.requireParticipantDetail(participantId);
  }

  /** Hides a participant while retaining immutable room history, cycles, and usage. */
  deleteParticipant(participantId: string): void {
    this.transaction(() => {
      const participant = this.getParticipant(participantId); if (!participant) throw new Error("participant not found");
      if (participant.runtime.activeCycleId || this.db.prepare("SELECT 1 FROM cycles WHERE participant_id = ? AND status = 'calling' LIMIT 1").get(participantId)) throw new Error("participant has an active cycle");
      const now = this.now();
      this.db.prepare("UPDATE participants SET enabled = 0, connection_id = NULL, deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, participantId);
      this.db.prepare("UPDATE participant_runtime SET next_poll_at = NULL, status = 'off' WHERE participant_id = ?").run(participantId);
    });
  }

  /** Atomically checks unread foreign messages and reserves the participant's one active cycle. */
  claimCycle(input: { participantId: string; serverRunId: string; cycleId?: string }): ClaimedCycle | null {
    return this.transaction(() => {
      const detail = this.getParticipant(input.participantId);
      if (!detail || !detail.enabled || detail.runtime.activeCycleId || detail.runtime.permanentError) return null;
      const thread = this.getCurrentThread(detail.roomId); if (!thread) throw new Error("room has no current thread");
      const messages = this.listThreadRes(thread.id);
      const observed = detail.runtime.observed;
      const inputSignature = this.inputSignature(detail);
      if (detail.runtime.status === "input_blocked" && detail.runtime.blockedAt?.threadId === thread.id && detail.runtime.blockedAt.resNumber === thread.resCount && detail.runtime.blockedInputSignature === inputSignature) return null;
      const after = observed?.threadId === thread.id ? observed.resNumber : 0;
      const hasForeignUnread = messages.some((message) => message.number > after && (message.author.type !== "participant" || message.author.id !== detail.id));
      if (!hasForeignUnread) return null;
      const cycleId = input.cycleId ?? randomUUID(); const startedAt = this.now();
      const maxPostRow = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS max_post_id FROM posts WHERE room_id = ?").get(detail.roomId) as SqlRow;
      const snapshot: CycleSnapshot = { threadId: thread.id, threadNumber: thread.number, latestResNumber: thread.resCount, maxPostId: number(maxPostRow.max_post_id), observedBefore: observed };
      this.db.prepare("INSERT INTO cycles (id, participant_id, room_id, server_run_id, snapshot_thread_id, snapshot_thread_number, snapshot_res, snapshot_post_id, input_signature, observed_thread_id, observed_res, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'calling', ?)")
        .run(cycleId, detail.id, detail.roomId, input.serverRunId, snapshot.threadId, snapshot.threadNumber, snapshot.latestResNumber, snapshot.maxPostId, inputSignature, observed?.threadId ?? null, observed?.resNumber ?? null, startedAt);
      this.db.prepare("UPDATE participant_runtime SET active_cycle_id = ?, status = 'calling', last_error = NULL, next_poll_at = NULL WHERE participant_id = ?").run(cycleId, detail.id);
      const inputDto = this.buildModelInput(detail, thread);
      const cycle: Cycle = { id: cycleId, participantId: detail.id, roomId: detail.roomId, serverRunId: input.serverRunId, snapshot, inputSignature, status: "calling", startedAt, completedAt: null, error: null };
      return { cycle, participant: this.participantOnly(detail), connection: detail.connectionId ? this.getConnection(detail.connectionId) : null, input: inputDto };
    });
  }

  completeCycle(input: { cycleId: string; serverRunId: string; action: FinalAction }): { res: PublicRes | null; post: Post | null } {
    return this.transaction(() => {
      const cycle = this.requireActiveCycle(input.cycleId, input.serverRunId);
      const participant = this.requireParticipantDetail(cycle.participantId);
      if (input.action.memo !== undefined && input.action.memo !== null) this.assertMemo(input.action.memo);
      let res: PublicRes | null = null; let post: Post | null = null;
      const generatedFrom: Cursor = { threadId: cycle.snapshot.threadId, resNumber: cycle.snapshot.latestResNumber };
      if (input.action.action === "reply") {
        this.assertMessage(input.action.message);
        res = this.appendResInTransaction({ roomId: cycle.roomId, author: { type: "participant", id: participant.id, displayName: participant.displayName }, body: input.action.message, generatedFrom });
      } else if (input.action.action === "post") {
        this.assertPost(input.action.title, input.action.body);
        const now = this.now();
        const inserted = this.db.prepare("INSERT INTO posts (room_id, author_type, author_id, author_display_name, title, body, created_at) VALUES (?, 'participant', ?, ?, ?, ?, ?)")
          .run(cycle.roomId, participant.id, participant.displayName, input.action.title, input.action.body, now);
        const postId = Number(inserted.lastInsertRowid); const body = `${input.action.message}\n>>P${postId}`; this.assertMessage(body);
        post = { id: postId, roomId: cycle.roomId, author: { type: "participant", id: participant.id, displayName: participant.displayName }, title: input.action.title, body: input.action.body, createdAt: now, deletedAt: null };
        res = this.appendResInTransaction({ roomId: cycle.roomId, author: post.author, body, generatedFrom }, postId, now);
      }
      const memo = input.action.memo === undefined || input.action.memo === null ? participant.privateMemo : input.action.memo;
      const nextStatus = participant.enabled ? "idle" : "off";
      this.db.prepare("UPDATE participants SET private_memo = ?, updated_at = ? WHERE id = ?").run(memo, this.now(), participant.id);
      this.db.prepare("UPDATE participant_runtime SET observed_thread_id = ?, observed_res = ?, last_posted_thread_id = ?, last_posted_res = ?, active_cycle_id = NULL, status = ?, last_error = NULL, blocked_thread_id = NULL, blocked_res = NULL, blocked_input_signature = NULL, permanent_error = 0 WHERE participant_id = ?")
        .run(cycle.snapshot.threadId, cycle.snapshot.latestResNumber, res?.threadId ?? participant.runtime.lastPosted?.threadId ?? null, res?.number ?? participant.runtime.lastPosted?.resNumber ?? null, nextStatus, participant.id);
      this.db.prepare("UPDATE cycles SET status = 'completed', completed_at = ? WHERE id = ?").run(this.now(), cycle.id);
      this.recordCycleEvent(cycle.id, 'final', { action: input.action.action, resId: res?.id ?? null, postId: post?.id ?? null, thread: res?.threadNumber ?? null, res: res?.number ?? null });
      return { res, post };
    });
  }

  failCycle(input: { cycleId: string; serverRunId: string; error: string; status?: "failed" | "input_blocked"; permanent?: boolean }): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM cycles WHERE id = ? AND server_run_id = ? AND status = 'calling'").get(input.cycleId, input.serverRunId) as SqlRow | undefined;
      if (!row) return false;
      const cycle = this.mapCycle(row); const participant = this.requireParticipantDetail(cycle.participantId); const state = input.status ?? "failed";
      this.db.prepare("UPDATE cycles SET status = ?, completed_at = ?, error = ? WHERE id = ?").run(state, this.now(), input.error, cycle.id);
      const inputChanged = cycle.inputSignature !== this.inputSignature(participant);
      const permanent = Boolean(input.permanent) && !inputChanged;
      this.db.prepare("UPDATE participant_runtime SET active_cycle_id = NULL, status = ?, last_error = ?, blocked_thread_id = ?, blocked_res = ?, blocked_input_signature = ?, permanent_error = ? WHERE participant_id = ? AND active_cycle_id = ?").run(participant.enabled ? (inputChanged ? "idle" : state === "input_blocked" ? "input_blocked" : "error") : "off", inputChanged ? null : input.error, inputChanged || state !== "input_blocked" ? null : cycle.snapshot.threadId, inputChanged || state !== "input_blocked" ? null : cycle.snapshot.latestResNumber, inputChanged || state !== "input_blocked" ? null : cycle.inputSignature, Number(permanent), participant.id, cycle.id);
      return true;
    });
  }

  recordUsage(input: { participantId: string; connectionId: string | null; cycleId: string; participantName?: string; connectionName?: string; connectionType?: string; requestId?: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number | null; providerUsage?: Record<string, unknown> }): UsageRecord {
    const createdAt = this.now();
    const participant = this.requireParticipantDetail(input.participantId); const currentConnection = input.connectionId ? this.getConnection(input.connectionId) : null; const connection = currentConnection ? { ...currentConnection, name: input.connectionName ?? currentConnection.name, type: input.connectionType ?? currentConnection.type } : null; participant.displayName = input.participantName ?? participant.displayName; const simulated = input.providerUsage?.simulated === true || connection?.type === 'mock';
    const result = this.db.prepare("INSERT INTO usage (participant_id, participant_name, connection_id, connection_name, connection_type, simulated, cycle_id, request_id, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, provider_usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.participantId, participant.displayName, input.connectionId, connection?.name ?? null, connection?.type ?? null, Number(simulated), input.cycleId, input.requestId ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.cachedInputTokens ?? null, input.reasoningTokens ?? null, input.providerUsage ? json(sanitizeError(input.providerUsage)) : null, createdAt);
    return { id: Number(result.lastInsertRowid), participantId: input.participantId, participantName: participant.displayName, connectionId: input.connectionId, connectionName: connection?.name ?? null, connectionType: connection?.type ?? null, participantDeleted: false, connectionDeleted: false, simulated, cycleId: input.cycleId, requestId: input.requestId ?? null, inputTokens: input.inputTokens ?? null, outputTokens: input.outputTokens ?? null, cachedInputTokens: input.cachedInputTokens ?? null, reasoningTokens: input.reasoningTokens ?? null, providerUsage: input.providerUsage ?? null, createdAt };
  }

  updateUsage(usageId: number, usage: { requestId?: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number | null; providerUsage?: Record<string, unknown> }, cycleId?: string): void {
    const suffix = cycleId ? ' AND cycle_id = ?' : '';
    this.db.prepare(`UPDATE usage SET request_id = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, reasoning_tokens = ?, provider_usage_json = ? WHERE id = ?${suffix}`)
      .run(usage.requestId ?? null, usage.inputTokens ?? null, usage.outputTokens ?? null, usage.cachedInputTokens ?? null, usage.reasoningTokens ?? null, usage.providerUsage ? json(sanitizeError(usage.providerUsage)) : null, usageId, ...(cycleId ? [cycleId] : []));
  }

  getUsageSummary(input: { roomId?: string; participantId?: string } = {}): UsageSummary {
    const clauses: string[] = []; const values: string[] = [];
    let join = ""; if (input.roomId) { join = " JOIN participants p ON p.id = u.participant_id"; clauses.push("p.room_id = ?"); values.push(input.roomId); }
    if (input.participantId) { clauses.push("u.participant_id = ?"); values.push(input.participantId); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens FROM usage u${join}${where}`).get(...values) as SqlRow;
    return { calls: number(row.calls), inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), cachedInputTokens: number(row.cached_input_tokens) };
  }

  listUsage(roomId: string, filters: { participantId?: string; connectionId?: string; cycleId?: string; limit?: number; beforeId?: number } = {}): UsageRecord[] {
    const clauses = ['c.room_id = ?']; const values: SQLInputValue[] = [roomId];
    for (const [column, value] of [['u.participant_id', filters.participantId], ['u.connection_id', filters.connectionId], ['u.cycle_id', filters.cycleId]] as const) if (value) { clauses.push(`${column} = ?`); values.push(value); }
    if (filters.beforeId) { clauses.push('u.id < ?'); values.push(filters.beforeId); }
    values.push(Math.min(Math.max(filters.limit ?? 100, 1), 500));
    return (this.db.prepare(`SELECT u.*, p.deleted_at AS participant_deleted_at, c_active.id AS active_connection_id FROM usage u JOIN cycles c ON c.id = u.cycle_id LEFT JOIN participants p ON p.id = u.participant_id LEFT JOIN connections c_active ON c_active.id = u.connection_id WHERE ${clauses.join(' AND ')} ORDER BY u.id DESC LIMIT ?`).all(...values) as SqlRow[]).map((row) => this.mapUsage(row));
  }
  getUsageDetails(roomId: string): UsageDetails {
    const aggregate = (kind: 'participant' | 'connection'): UsageAggregate[] => {
      const id = kind === 'participant' ? 'u.participant_id' : 'u.connection_id'; const name = kind === 'participant' ? 'u.participant_name' : 'u.connection_name'; const type = kind === 'connection' ? 'u.connection_type' : 'NULL';
      const deleted = kind === 'participant' ? "MAX(CASE WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END)" : "MAX(CASE WHEN u.connection_id IS NOT NULL AND c_active.id IS NULL THEN 1 ELSE 0 END)";
      return (this.db.prepare(`SELECT ${id} AS id, MAX(${name}) AS display_name, MAX(${type}) AS type, COUNT(*) AS calls, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.cached_input_tokens) AS cached_input_tokens, SUM(u.reasoning_tokens) AS reasoning_tokens, MAX(u.simulated) AS simulated, ${deleted} AS deleted FROM usage u JOIN cycles cy ON cy.id = u.cycle_id LEFT JOIN participants p ON p.id = u.participant_id LEFT JOIN connections c_active ON c_active.id = u.connection_id WHERE cy.room_id = ? GROUP BY ${id}`).all(roomId) as SqlRow[]).map((row) => ({ id: String(row.id), displayName: nullableString(row.display_name), type: nullableString(row.type), calls: number(row.calls), inputTokens: row.input_tokens === null ? null : number(row.input_tokens), outputTokens: row.output_tokens === null ? null : number(row.output_tokens), cachedInputTokens: row.cached_input_tokens === null ? null : number(row.cached_input_tokens), reasoningTokens: row.reasoning_tokens === null ? null : number(row.reasoning_tokens), simulated: Boolean(row.simulated), deleted: Boolean(row.deleted) }));
    };
    return { participants: aggregate('participant'), connections: aggregate('connection') };
  }
  /** Compact dashboard aggregates. Usage is bounded by request time; cycle status is bounded by cycle start time. */
  getDashboard(roomId: string, input: { period: DashboardPeriod; mode: DashboardMode; participantId?: string; connectionId?: string }): DashboardData {
    if (!['today', '7d', '30d'].includes(input.period)) throw new Error('invalid dashboard period');
    if (!['real', 'mock'].includes(input.mode)) throw new Error('invalid dashboard mode');
    const now = this.now(); const start = new Date(now); start.setHours(0, 0, 0, 0);
    const days = input.period === 'today' ? 1 : input.period === '7d' ? 7 : 30;
    start.setDate(start.getDate() - (days - 1));
    const from = start.getTime(), to = now, bucket = input.period === 'today' ? 'hour' as const : 'day' as const;
    const modeValue = input.mode === 'mock' ? 1 : 0;
    const usageClauses = ['cy.room_id = ?', 'u.created_at >= ?', 'u.created_at <= ?', 'u.simulated = ?'];
    const usageValues: SQLInputValue[] = [roomId, from, to, modeValue];
    if (input.participantId) { usageClauses.push('u.participant_id = ?'); usageValues.push(input.participantId); }
    if (input.connectionId) { usageClauses.push('u.connection_id = ?'); usageValues.push(input.connectionId); }
    const usageWhere = usageClauses.join(' AND ');
    const choiceUsageWhere = ['cy.room_id = ?', 'u.created_at >= ?', 'u.created_at <= ?', 'u.simulated = ?'].join(' AND ');
    const choiceUsageValues: SQLInputValue[] = [roomId, from, to, modeValue];
    const tokenColumns = "COUNT(*) AS calls, COALESCE(SUM(u.input_tokens), 0) AS input_tokens, COALESCE(SUM(u.output_tokens), 0) AS output_tokens, SUM(CASE WHEN u.input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS input_known_calls, SUM(CASE WHEN u.output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS output_known_calls";
    const usageTotal = this.db.prepare(`SELECT ${tokenColumns} FROM usage u JOIN cycles cy ON cy.id = u.cycle_id WHERE ${usageWhere}`).get(...usageValues) as SqlRow;
    const usageBuckets = bucket === 'hour'
      ? this.db.prepare(`SELECT CAST((u.created_at - ?) / 3600000 AS INTEGER) AS bucket_key, ${tokenColumns} FROM usage u JOIN cycles cy ON cy.id = u.cycle_id WHERE ${usageWhere} GROUP BY bucket_key ORDER BY bucket_key`).all(from, ...usageValues) as SqlRow[]
      : this.db.prepare(`SELECT strftime('%Y-%m-%d', u.created_at / 1000, 'unixepoch', 'localtime') AS bucket_label, ${tokenColumns} FROM usage u JOIN cycles cy ON cy.id = u.cycle_id WHERE ${usageWhere} GROUP BY bucket_label ORDER BY bucket_label`).all(...usageValues) as SqlRow[];
    const usageParticipants = this.db.prepare(`SELECT stats.*, COALESCE(latest.participant_name, p.display_name) AS display_name, CASE WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS deleted FROM (SELECT u.participant_id AS id, MAX(u.id) AS latest_id, ${tokenColumns} FROM usage u JOIN cycles cy ON cy.id = u.cycle_id WHERE ${usageWhere} GROUP BY u.participant_id) stats JOIN usage latest ON latest.id = stats.latest_id LEFT JOIN participants p ON p.id = stats.id`).all(...usageValues) as SqlRow[];

    const baseCycleClauses = ['cy.room_id = ?', 'cy.started_at >= ?', 'cy.started_at <= ?'];
    const cycleClauses = [...baseCycleClauses]; const cycleValues: SQLInputValue[] = [roomId, from, to];
    if (input.participantId) { cycleClauses.push('cy.participant_id = ?'); cycleValues.push(input.participantId); }
    const cycleClassification = (clauses: string[]) => `WITH cycle_classified AS (
      SELECT cy.participant_id, cy.status, p.display_name, p.deleted_at,
        COALESCE(first_usage.connection_id, CASE WHEN json_valid(cy.input_signature) THEN json_extract(cy.input_signature, '$.connection.id') END) AS connection_id,
        CASE WHEN first_usage.id IS NOT NULL THEN first_usage.simulated
          WHEN CASE WHEN json_valid(cy.input_signature) THEN json_extract(cy.input_signature, '$.connection.type') END IS NOT NULL
          THEN CASE WHEN json_extract(cy.input_signature, '$.connection.type') = 'mock' THEN 1 ELSE 0 END
          ELSE NULL END AS simulated
      FROM cycles cy
      LEFT JOIN usage first_usage ON first_usage.id = (SELECT u.id FROM usage u WHERE u.cycle_id = cy.id ORDER BY u.id LIMIT 1)
      LEFT JOIN participants p ON p.id = cy.participant_id
      WHERE ${clauses.join(' AND ')}
    )`;
    const cycleMode = input.connectionId ? 'connection_id = ? AND simulated = ?' : '(simulated = ?)';
    const cycleModeValues: SQLInputValue[] = input.connectionId ? [...cycleValues, input.connectionId, modeValue] : [...cycleValues, modeValue];
    const cycleColumns = "SUM(CASE WHEN status = 'calling' THEN 1 ELSE 0 END) AS calling, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned, SUM(CASE WHEN status = 'input_blocked' THEN 1 ELSE 0 END) AS input_blocked";
    const cycleTotal = this.db.prepare(`${cycleClassification(cycleClauses)} SELECT ${cycleColumns} FROM cycle_classified WHERE ${cycleMode}`).get(...cycleModeValues) as SqlRow;
    const cycleParticipants = this.db.prepare(`${cycleClassification(cycleClauses)} SELECT participant_id AS id, MAX(display_name) AS display_name, MAX(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted, ${cycleColumns} FROM cycle_classified WHERE ${cycleMode} GROUP BY participant_id`).all(...cycleModeValues) as SqlRow[];
    const unclassifiedCycles = input.connectionId ? 0 : number((this.db.prepare(`${cycleClassification(cycleClauses)} SELECT COUNT(*) AS count FROM cycle_classified WHERE simulated IS NULL`).get(...cycleValues) as SqlRow).count);

    const tokenAggregate = (row: SqlRow) => {
      const calls = number(row.calls), inputKnownCalls = number(row.input_known_calls), outputKnownCalls = number(row.output_known_calls);
      return { calls, inputTokens: calls > 0 && inputKnownCalls === 0 ? null : number(row.input_tokens), outputTokens: calls > 0 && outputKnownCalls === 0 ? null : number(row.output_tokens), inputKnownCalls, outputKnownCalls };
    };
    const cycleAggregate = (row: SqlRow): DashboardCycleCounts => ({ calling: number(row.calling ?? 0), completed: number(row.completed ?? 0), failed: number(row.failed ?? 0), abandoned: number(row.abandoned ?? 0), input_blocked: number(row.input_blocked ?? 0) });
    const localLabel = (value: Date, hour = false): string => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}${hour ? ` ${String(value.getHours()).padStart(2, '0')}:00` : ''}`;
    const bucketMap = new Map<string | number, SqlRow>();
    for (const row of usageBuckets) bucketMap.set(bucket === 'hour' ? number(row.bucket_key) : String(row.bucket_label), row);
    const buckets: DashboardData['buckets'] = [];
    if (bucket === 'hour') {
      for (let key = 0; from + key * 3_600_000 <= to; key += 1) {
        const bucketStart = from + key * 3_600_000, value = new Date(bucketStart), row = bucketMap.get(key);
        buckets.push({ start: bucketStart, end: Math.min(bucketStart + 3_600_000, to), label: localLabel(value, true), ...(row ? tokenAggregate(row) : { calls: 0, inputTokens: 0, outputTokens: 0, inputKnownCalls: 0, outputKnownCalls: 0 }) });
      }
    } else {
      const value = new Date(from);
      while (value.getTime() <= to) {
        const label = localLabel(value), row = bucketMap.get(label), bucketStart = value.getTime(), next = new Date(bucketStart); next.setDate(next.getDate() + 1);
        buckets.push({ start: bucketStart, end: Math.min(next.getTime(), to), label, ...(row ? tokenAggregate(row) : { calls: 0, inputTokens: 0, outputTokens: 0, inputKnownCalls: 0, outputKnownCalls: 0 }) });
        value.setDate(value.getDate() + 1);
      }
    }
    const participantMap = new Map<string, DashboardData['participants'][number]>();
    for (const row of usageParticipants) participantMap.set(String(row.id), { id: String(row.id), displayName: nullableString(row.display_name), deleted: Boolean(row.deleted), ...tokenAggregate(row), cycles: cycleAggregate({}) });
    for (const row of cycleParticipants) {
      const id = String(row.id); const existing = participantMap.get(id);
      if (existing) { existing.cycles = cycleAggregate(row); existing.deleted ||= Boolean(row.deleted); if (!existing.displayName) existing.displayName = nullableString(row.display_name); }
      else participantMap.set(id, { id, displayName: nullableString(row.display_name), deleted: Boolean(row.deleted), calls: 0, inputTokens: 0, outputTokens: 0, inputKnownCalls: 0, outputKnownCalls: 0, cycles: cycleAggregate(row) });
    }
    const choiceParticipants = new Map<string, DashboardChoice>();
    for (const row of this.db.prepare(`SELECT stats.id, COALESCE(latest.participant_name, p.display_name) AS display_name, CASE WHEN p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS deleted FROM (SELECT u.participant_id AS id, MAX(u.id) AS latest_id FROM usage u JOIN cycles cy ON cy.id = u.cycle_id WHERE ${choiceUsageWhere} GROUP BY u.participant_id) stats JOIN usage latest ON latest.id = stats.latest_id LEFT JOIN participants p ON p.id = stats.id`).all(...choiceUsageValues) as SqlRow[]) choiceParticipants.set(String(row.id), { id: String(row.id), displayName: nullableString(row.display_name), deleted: Boolean(row.deleted) });
    for (const row of this.db.prepare(`${cycleClassification(baseCycleClauses)} SELECT participant_id AS id, MAX(display_name) AS display_name, MAX(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted FROM cycle_classified WHERE simulated = ? GROUP BY participant_id`).all(roomId, from, to, modeValue) as SqlRow[]) if (!choiceParticipants.has(String(row.id))) choiceParticipants.set(String(row.id), { id: String(row.id), displayName: nullableString(row.display_name), deleted: Boolean(row.deleted) });
    const choiceConnections = new Map<string, DashboardChoice>();
    for (const row of this.db.prepare(`SELECT stats.id, COALESCE(latest.connection_name, c.name) AS display_name, COALESCE(latest.connection_type, c.type) AS type, CASE WHEN c.id IS NULL THEN 1 ELSE 0 END AS deleted FROM (SELECT u.connection_id AS id, MAX(u.id) AS latest_id FROM usage u JOIN cycles cy ON cy.id = u.cycle_id WHERE ${choiceUsageWhere} AND u.connection_id IS NOT NULL GROUP BY u.connection_id) stats JOIN usage latest ON latest.id = stats.latest_id LEFT JOIN connections c ON c.id = stats.id`).all(...choiceUsageValues) as SqlRow[]) choiceConnections.set(String(row.id), { id: String(row.id), displayName: nullableString(row.display_name), type: nullableString(row.type), deleted: Boolean(row.deleted) });
    for (const row of this.db.prepare(`${cycleClassification(baseCycleClauses)} SELECT connection_id AS id, MAX(c.type) AS type, MAX(c.name) AS display_name, MAX(CASE WHEN c.id IS NULL THEN 1 ELSE 0 END) AS deleted FROM cycle_classified LEFT JOIN connections c ON c.id = cycle_classified.connection_id WHERE simulated = ? AND connection_id IS NOT NULL GROUP BY connection_id`).all(roomId, from, to, modeValue) as SqlRow[]) if (!choiceConnections.has(String(row.id))) choiceConnections.set(String(row.id), { id: String(row.id), displayName: nullableString(row.display_name), type: nullableString(row.type), deleted: Boolean(row.deleted) });
    const connections = [...choiceConnections.values()].sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id));
    const participants = [...participantMap.values()].sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id));
    return {
      range: { from, to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, bucket },
      filters: { period: input.period, mode: input.mode, participantId: input.participantId ?? null, connectionId: input.connectionId ?? null },
      totals: { ...tokenAggregate(usageTotal), cycles: cycleAggregate(cycleTotal), unclassifiedCycles },
      buckets,
      participants,
      choices: { participants: [...choiceParticipants.values()].sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id)), connections },
    };
  }
  listCycles(roomId: string, filters: { participantId?: string; limit?: number; beforeStartedAt?: number } = {}): Cycle[] {
    const clauses = ['room_id = ?']; const values: SQLInputValue[] = [roomId]; if (filters.participantId) { clauses.push('participant_id = ?'); values.push(filters.participantId); } if (filters.beforeStartedAt) { clauses.push('started_at < ?'); values.push(filters.beforeStartedAt); } values.push(Math.min(Math.max(filters.limit ?? 100, 1), 500));
    return (this.db.prepare(`SELECT cy.*, p.deleted_at AS participant_deleted_at, COALESCE((SELECT u.participant_name FROM usage u WHERE u.cycle_id = cy.id AND u.participant_name IS NOT NULL ORDER BY u.id LIMIT 1), p.display_name) AS participant_name FROM cycles cy LEFT JOIN participants p ON p.id = cy.participant_id WHERE ${clauses.map((clause) => clause.replace(/^room_id/, 'cy.room_id').replace(/^participant_id/, 'cy.participant_id').replace(/^started_at/, 'cy.started_at')).join(' AND ')} ORDER BY cy.started_at DESC LIMIT ?`).all(...values) as SqlRow[]).map((row) => this.mapCycle(row));
  }
  getCycleOverview(cycleId: string): { finalAction: string | null; result: Record<string, unknown> | null; errorId: number | null; connection: CycleConnection | null } {
    const row = this.db.prepare("SELECT payload_json FROM cycle_events WHERE cycle_id = ? AND kind = 'final' ORDER BY id DESC LIMIT 1").get(cycleId) as SqlRow | undefined;
    const final = row ? parseObject(row.payload_json) : null;
    const error = this.db.prepare('SELECT id FROM errors WHERE cycle_id = ? ORDER BY id DESC LIMIT 1').get(cycleId) as SqlRow | undefined;
    return { finalAction: typeof final?.action === 'string' ? final.action : null, result: final ? { resId: final.resId ?? null, postId: final.postId ?? null, thread: final.thread ?? null, res: final.res ?? null } : null, errorId: error ? number(error.id) : null, connection: this.getCycleConnection(cycleId) };
  }
  getParticipantCycleState(participant: ParticipantDetail) {
    const active = participant.runtime.activeCycleId ? this.db.prepare('SELECT started_at FROM cycles WHERE id = ?').get(participant.runtime.activeCycleId) as SqlRow | undefined : undefined;
    const last = this.db.prepare("SELECT id, completed_at FROM cycles WHERE participant_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC, rowid DESC LIMIT 1").get(participant.id) as SqlRow | undefined;
    const action = this.db.prepare("SELECT e.payload_json FROM cycle_events e JOIN cycles c ON c.id = e.cycle_id WHERE c.participant_id = ? AND e.kind = 'final' ORDER BY e.id DESC LIMIT 1").get(participant.id) as SqlRow | undefined;
    const observed = participant.runtime.observed ? this.db.prepare('SELECT number FROM threads WHERE id = ?').get(participant.runtime.observed.threadId) as SqlRow | undefined : undefined;
    return { activeStartedAt: active ? number(active.started_at) : null, lastCompletedAt: last ? number(last.completed_at) : null, lastAction: action ? parseObject(action.payload_json).action : null, observedThreadNumber: observed ? number(observed.number) : null };
  }
  getCycleDetail(roomId: string, cycleId: string): CycleDetail | null {
    const row = this.db.prepare('SELECT cy.*, p.deleted_at AS participant_deleted_at, COALESCE((SELECT u.participant_name FROM usage u WHERE u.cycle_id = cy.id AND u.participant_name IS NOT NULL ORDER BY u.id LIMIT 1), p.display_name) AS participant_name FROM cycles cy LEFT JOIN participants p ON p.id = cy.participant_id WHERE cy.id = ? AND cy.room_id = ?').get(cycleId, roomId) as SqlRow | undefined; if (!row) return null; const cycle = this.mapCycle(row);
    const events = (this.db.prepare('SELECT * FROM cycle_events WHERE cycle_id = ? ORDER BY id').all(cycleId) as SqlRow[]).map((event) => this.mapCycleEvent(event)); const usage = this.listUsage(roomId, { cycleId, limit: 500 });
    const final = events.find((event) => event.kind === 'final')?.payload;
    return { cycle, events, usage, result: final ? { resId: typeof final.resId === 'number' ? final.resId : null, postId: typeof final.postId === 'number' ? final.postId : null } : null, connection: this.getCycleConnection(cycleId) };
  }
  recordCycleEvent(cycleId: string, kind: CycleEvent['kind'], payload?: Record<string, unknown>): CycleEvent { const result = this.db.prepare('INSERT INTO cycle_events (cycle_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)').run(cycleId, kind, payload ? json(sanitizeError(payload)) : null, this.now()); return { id: Number(result.lastInsertRowid), cycleId, kind, payload: sanitizeError(payload) ?? null, createdAt: this.now() }; }
  recordError(input: Omit<ErrorRecord, 'id' | 'createdAt'>): ErrorRecord { const safe = sanitizeError(input); const result = this.db.prepare('INSERT INTO errors (room_id, source, participant_id, connection_id, cycle_id, http_status, provider_code, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.roomId, safe.source, input.participantId, input.connectionId, input.cycleId, input.httpStatus, safe.providerCode, String(safe.message ?? '오류'), safe.details === undefined ? null : json(safe.details), this.now()); return { ...input, id: Number(result.lastInsertRowid), message: String(safe.message ?? '오류'), details: safe.details, createdAt: this.now() }; }
  listErrors(roomId: string, filters: { participantId?: string; connectionId?: string; cycleId?: string; limit?: number; beforeId?: number } = {}): ErrorRecord[] { const clauses = ['room_id = ?']; const values: SQLInputValue[] = [roomId]; for (const [column, value] of [['participant_id', filters.participantId], ['connection_id', filters.connectionId], ['cycle_id', filters.cycleId]] as const) if (value) { clauses.push(`${column} = ?`); values.push(value); } if (filters.beforeId) { clauses.push('id < ?'); values.push(filters.beforeId); } values.push(Math.min(Math.max(filters.limit ?? 100, 1), 500)); return (this.db.prepare(`SELECT * FROM errors WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...values) as SqlRow[]).map((row) => this.mapError(row)); }
  clearErrors(roomId: string): number { return Number(this.db.prepare('DELETE FROM errors WHERE room_id = ?').run(roomId).changes); }
  getError(roomId: string, id: number): ErrorRecord | null { const row = this.db.prepare('SELECT * FROM errors WHERE room_id = ? AND id = ?').get(roomId, id) as SqlRow | undefined; return row ? this.mapError(row) : null; }

  setNextPoll(participantId: string, at: number | null): void {
    this.db.prepare("UPDATE participant_runtime SET next_poll_at = ? WHERE participant_id = ? AND active_cycle_id IS NULL").run(at, participantId);
  }

  abandonStaleCycles(): number {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE cycles SET status = 'abandoned', completed_at = ?, error = 'server restarted' WHERE status = 'calling'").run(this.now());
      this.db.exec("UPDATE participant_runtime SET active_cycle_id = NULL, status = CASE WHEN (SELECT enabled FROM participants p WHERE p.id = participant_runtime.participant_id) = 1 THEN 'idle' ELSE 'off' END WHERE active_cycle_id IS NOT NULL");
      return Number(result.changes);
    });
  }

  invalidateRun(serverRunId: string): number {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE cycles SET status = 'abandoned', completed_at = ?, error = 'server stopped' WHERE server_run_id = ? AND status = 'calling'").run(this.now(), serverRunId);
      this.db.prepare("UPDATE participant_runtime SET active_cycle_id = NULL, status = CASE WHEN (SELECT enabled FROM participants p WHERE p.id = participant_runtime.participant_id) = 1 THEN 'idle' ELSE 'off' END WHERE active_cycle_id IN (SELECT id FROM cycles WHERE server_run_id = ? AND status = 'abandoned')").run(serverRunId);
      return Number(result.changes);
    });
  }

  private get resSelect(): string {
    return "SELECT r.*, t.number AS thread_number, t.deleted_at AS thread_deleted_at FROM res r JOIN threads t ON t.id = r.thread_id";
  }

  private appendResInTransaction(input: AppendResInput, postId: number | null = null, createdAt = this.now()): PublicRes {
    const room = this.getRoom(input.roomId); if (!room) throw new Error("room not found");
    const thread = this.getCurrentThread(input.roomId); if (!thread || thread.status !== "open") throw new Error("room has no open thread");
    if (thread.resCount >= 1000) throw new Error("open thread is already full");
    const resNumber = thread.resCount + 1; const generated = input.generatedFrom ?? null;
    const inserted = this.db.prepare("INSERT INTO res (thread_id, number, author_type, author_id, author_display_name, body, post_id, generated_from_thread_id, generated_from_res, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(thread.id, resNumber, input.author.type, input.author.id, input.author.displayName, input.body, postId, generated?.threadId ?? null, generated?.resNumber ?? null, createdAt);
    const res: PublicRes = { id: Number(inserted.lastInsertRowid), threadId: thread.id, threadNumber: thread.number, number: resNumber, author: input.author, body: input.body, postId, generatedFrom: generated, createdAt };
    this.addSearchIndex(res, room.id);
    this.db.prepare("UPDATE threads SET res_count = ? WHERE id = ?").run(resNumber, thread.id);
    if (resNumber === 1000) {
      const nextId = randomUUID(); const now = this.now();
      this.db.prepare("UPDATE threads SET status = 'closed', closed_at = ? WHERE id = ?").run(now, thread.id);
      this.db.prepare("INSERT INTO threads (id, room_id, number, status, res_count, created_at) VALUES (?, ?, ?, 'open', 0, ?)").run(nextId, room.id, thread.number + 1, now);
      this.db.prepare("UPDATE rooms SET current_thread_id = ? WHERE id = ?").run(nextId, room.id);
    }
    return res;
  }

  private requireActiveCycle(cycleId: string, serverRunId: string): Cycle {
    const row = this.db.prepare("SELECT * FROM cycles WHERE id = ? AND server_run_id = ? AND status = 'calling'").get(cycleId, serverRunId) as SqlRow | undefined;
    if (!row) throw new Error("cycle is no longer active for this server run");
    const cycle = this.mapCycle(row); const runtime = this.requireParticipantDetail(cycle.participantId).runtime;
    if (runtime.activeCycleId !== cycleId) throw new Error("cycle is not the participant's active cycle");
    return cycle;
  }

  private assertMessage(body: string): void { if (!body.trim()) throw new Error("message is required"); assertTokenLimit(body, this.limits.messageTokens, "message", this.tokens); }
  private assertMemo(memo: string): void { assertTokenLimit(memo, this.limits.privateMemoTokens, "private memo", this.tokens); }
  private assertPost(title: string, body: string): void { if (!title.trim() || !body.trim()) throw new Error("post title and body are required"); assertTokenLimit(`${title}\n${body}`, this.limits.postTokens, "post", this.tokens); }
  private requireParticipantDetail(id: string): ParticipantDetail { const participant = this.getParticipant(id); if (!participant) throw new Error("participant not found"); return participant; }
  private participantOnly(detail: ParticipantDetail): Participant { const { runtime: _runtime, ...participant } = detail; return participant; }
  private validateAuthor(roomId: string, author: PublicRes["author"]): PublicRes["author"] {
    if (!author.displayName.trim()) throw new Error("author display name is required");
    if (author.type === "admin") { if (author.id !== null) throw new Error("admin author id must be null"); return { type: "admin", id: null, displayName: author.displayName }; }
    if (typeof author.id !== "string" || !author.id) throw new Error("participant author id is required");
    const participant = this.getParticipant(author.id);
    if (!participant || participant.roomId !== roomId) throw new Error("participant author does not belong to room");
    return { type: "participant", id: participant.id, displayName: participant.displayName };
  }
  private inputSignature(participant: Participant): string {
    const connection = participant.connectionId ? this.getConnection(participant.connectionId) : null;
    return JSON.stringify({ displayName: participant.displayName, modelId: participant.modelId, modelOptions: participant.modelOptions, systemPrompt: participant.systemPrompt, corePromptHash: createHash('sha256').update(this.getCorePrompt(participant.roomId), 'utf8').digest('hex'), privateMemo: participant.privateMemo, connection: connection ? { id: connection.id, type: connection.type, config: connection.config, credentialRef: connection.credentialRef } : null });
  }
  private transaction<T>(operation: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = operation(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, current_thread_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_settings (room_id TEXT PRIMARY KEY REFERENCES rooms(id), core_prompt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')), res_count INTEGER NOT NULL CHECK(res_count BETWEEN 0 AND 1000), created_at INTEGER NOT NULL, closed_at INTEGER, deleted_at INTEGER, UNIQUE(room_id, number));
      CREATE TABLE IF NOT EXISTS res (id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), number INTEGER NOT NULL CHECK(number BETWEEN 1 AND 1000), author_type TEXT NOT NULL CHECK(author_type IN ('admin','participant')), author_id TEXT, author_display_name TEXT NOT NULL, body TEXT NOT NULL, post_id INTEGER, generated_from_thread_id TEXT, generated_from_res INTEGER, created_at INTEGER NOT NULL, UNIQUE(thread_id, number));
      CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), author_type TEXT NOT NULL CHECK(author_type IN ('admin','participant')), author_id TEXT, author_display_name TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config_json TEXT NOT NULL, credential_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), display_name TEXT NOT NULL, avatar TEXT, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), connection_id TEXT REFERENCES connections(id), model_id TEXT NOT NULL, model_options_json TEXT NOT NULL, system_prompt TEXT NOT NULL, private_memo TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS participant_runtime (participant_id TEXT PRIMARY KEY REFERENCES participants(id), observed_thread_id TEXT, observed_res INTEGER, last_posted_thread_id TEXT, last_posted_res INTEGER, next_poll_at INTEGER, status TEXT NOT NULL, active_cycle_id TEXT, last_error TEXT, blocked_thread_id TEXT, blocked_res INTEGER, blocked_input_signature TEXT, permanent_error INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cycles (id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id), room_id TEXT NOT NULL REFERENCES rooms(id), server_run_id TEXT NOT NULL, snapshot_thread_id TEXT NOT NULL, snapshot_thread_number INTEGER NOT NULL, snapshot_res INTEGER NOT NULL, snapshot_post_id INTEGER NOT NULL DEFAULT 0, input_signature TEXT NOT NULL DEFAULT '', observed_thread_id TEXT, observed_res INTEGER, status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id), participant_name TEXT, connection_id TEXT, connection_name TEXT, connection_type TEXT, simulated INTEGER NOT NULL DEFAULT 0, cycle_id TEXT NOT NULL REFERENCES cycles(id), request_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, reasoning_tokens INTEGER, provider_usage_json TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cycle_events (id INTEGER PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES cycles(id), kind TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), source TEXT NOT NULL, participant_id TEXT, connection_id TEXT, cycle_id TEXT, http_status INTEGER, provider_code TEXT, message TEXT NOT NULL, details_json TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_res_thread_number ON res(thread_id, number); CREATE INDEX IF NOT EXISTS idx_threads_room_number ON threads(room_id, number); CREATE INDEX IF NOT EXISTS idx_cycles_participant_status ON cycles(participant_id, status); CREATE INDEX IF NOT EXISTS idx_usage_participant ON usage(participant_id); CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage(created_at); CREATE INDEX IF NOT EXISTS idx_usage_cycle ON usage(cycle_id, id); CREATE INDEX IF NOT EXISTS idx_cycles_room_started_at ON cycles(room_id, started_at);
      CREATE TABLE IF NOT EXISTS res_search (res_id INTEGER NOT NULL REFERENCES res(id), term TEXT NOT NULL, PRIMARY KEY (res_id, term)); CREATE INDEX IF NOT EXISTS idx_res_search_term ON res_search(term);
      CREATE TRIGGER IF NOT EXISTS res_is_immutable_update BEFORE UPDATE ON res BEGIN SELECT RAISE(ABORT, 'res is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS res_is_immutable_delete BEFORE DELETE ON res BEGIN SELECT RAISE(ABORT, 'res is immutable'); END;
      DROP TRIGGER IF EXISTS post_is_immutable_update;
      CREATE TRIGGER post_is_immutable_update BEFORE UPDATE ON posts WHEN OLD.id IS NOT NEW.id OR OLD.room_id IS NOT NEW.room_id OR OLD.author_type IS NOT NEW.author_type OR OLD.author_id IS NOT NEW.author_id OR OLD.author_display_name IS NOT NEW.author_display_name OR OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body OR OLD.created_at IS NOT NEW.created_at BEGIN SELECT RAISE(ABORT, 'post is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS post_is_immutable_delete BEFORE DELETE ON posts BEGIN SELECT RAISE(ABORT, 'post is immutable'); END;
    `);
    for (const migration of ["ALTER TABLE threads ADD COLUMN deleted_at INTEGER", "ALTER TABLE posts ADD COLUMN deleted_at INTEGER", "ALTER TABLE usage ADD COLUMN participant_name TEXT", "ALTER TABLE usage ADD COLUMN connection_name TEXT", "ALTER TABLE usage ADD COLUMN connection_type TEXT", "ALTER TABLE usage ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0", "ALTER TABLE usage ADD COLUMN reasoning_tokens INTEGER"]) try { this.db.exec(migration); } catch { /* Existing or freshly-created column. */ }
    this.ensureColumn("participant_runtime", "blocked_input_signature", "blocked_input_signature TEXT");
    this.ensureColumn("participant_runtime", "permanent_error", "permanent_error INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("participants", "deleted_at", "deleted_at INTEGER");
    this.ensureColumn("cycles", "snapshot_post_id", "snapshot_post_id INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("cycles", "input_signature", "input_signature TEXT NOT NULL DEFAULT ''");
    try { this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS res_fts USING fts5(body, author_display_name, res_id UNINDEXED, room_id UNINDEXED)"); this.hasFts5 = true; } catch { this.hasFts5 = false; }
  }

  private addSearchIndex(res: PublicRes, roomId: string): void {
    if (this.hasFts5) { this.db.prepare("INSERT INTO res_fts (body, author_display_name, res_id, room_id) VALUES (?, ?, ?, ?)").run(res.body, res.author.displayName, res.id, roomId); return; }
    const insert = this.db.prepare("INSERT OR IGNORE INTO res_search (res_id, term) VALUES (?, ?)");
    for (const term of searchTerms(res.body)) insert.run(res.id, term);
  }
  private ensureColumn(table: "participants" | "participant_runtime" | "cycles", column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    if (!columns.some((row) => String(row.name) === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }

  private mapRoom(row: SqlRow): Room { return { id: String(row.id), name: String(row.name), currentThreadId: String(row.current_thread_id), createdAt: number(row.created_at) }; }
  private mapThread(row: SqlRow): Thread { return { id: String(row.id), roomId: String(row.room_id), number: number(row.number), status: String(row.status) as Thread["status"], resCount: number(row.res_count), createdAt: number(row.created_at), closedAt: row.closed_at === null ? null : number(row.closed_at), deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : number(row.deleted_at) }; }
  private buildModelInput(detail: ParticipantDetail, thread: Thread): ModelInput {
    const messages = this.listThreadRes(thread.id); const observed = detail.runtime.observed; const after = observed?.threadId === thread.id ? observed.resNumber : 0;
    const references = new Map<number, { id: number; title: string; author: string }>();
    for (const message of messages) if (message.postId !== null) { const post = this.readPost(detail.roomId, message.postId); if (post) references.set(post.id, { id: post.id, title: post.title, author: post.author.displayName }); }
    return { participantName: detail.displayName, systemPrompt: detail.systemPrompt, corePrompt: this.getCorePrompt(detail.roomId), privateMemo: detail.privateMemo, currentThread: { id: thread.id, number: thread.number, latestResNumber: thread.resCount, isRolloverSinceObserved: observed?.threadId !== thread.id, newlyObservedAfter: after, messages: messages.map((message) => ({ thread: message.threadNumber, res: message.number, author: message.author.displayName, content: message.body, createdAt: message.createdAt })), postReferences: [...references.values()] } };
  }
  private mapRes(row: SqlRow): PublicRes { const deleted = row.thread_deleted_at !== null && row.thread_deleted_at !== undefined; return { id: number(row.id), threadId: String(row.thread_id), threadNumber: number(row.thread_number), number: number(row.number), author: { type: String(row.author_type) as PublicRes["author"]["type"], id: nullableString(row.author_id), displayName: String(row.author_display_name) }, body: deleted ? '관리자에 의해 삭제된 불판입니다.' : String(row.body), postId: row.post_id === null ? null : number(row.post_id), generatedFrom: row.generated_from_thread_id === null ? null : { threadId: String(row.generated_from_thread_id), resNumber: number(row.generated_from_res) }, createdAt: number(row.created_at) }; }
  private mapPost(row: SqlRow): Post { const deletedAt = row.deleted_at === null || row.deleted_at === undefined ? null : number(row.deleted_at); return { id: number(row.id), roomId: String(row.room_id), author: { type: String(row.author_type) as Post["author"]["type"], id: nullableString(row.author_id), displayName: String(row.author_display_name) }, title: deletedAt !== null ? '관리자에 의해 삭제된 게시글입니다.' : String(row.title), body: deletedAt !== null ? '관리자에 의해 삭제된 게시글입니다.' : String(row.body), createdAt: number(row.created_at), deletedAt }; }
  private getCycleConnection(cycleId: string): CycleConnection | null { const row = this.db.prepare('SELECT u.connection_id, u.connection_name, u.connection_type, c.id AS active_connection_id FROM usage u LEFT JOIN connections c ON c.id = u.connection_id WHERE u.cycle_id = ? AND u.connection_id IS NOT NULL ORDER BY u.id LIMIT 1').get(cycleId) as SqlRow | undefined; return row ? { id: String(row.connection_id), displayName: nullableString(row.connection_name), type: nullableString(row.connection_type), deleted: row.active_connection_id === null || row.active_connection_id === undefined } : null; }
  private mapUsage(row: SqlRow): UsageRecord { return { id: number(row.id), participantId: String(row.participant_id), participantName: nullableString(row.participant_name), connectionId: nullableString(row.connection_id), connectionName: nullableString(row.connection_name), connectionType: nullableString(row.connection_type), participantDeleted: row.participant_deleted_at !== null && row.participant_deleted_at !== undefined, connectionDeleted: row.connection_id !== null && row.connection_id !== undefined && (row.active_connection_id === null || row.active_connection_id === undefined), simulated: Boolean(row.simulated), cycleId: String(row.cycle_id), requestId: nullableString(row.request_id), inputTokens: row.input_tokens === null ? null : number(row.input_tokens), outputTokens: row.output_tokens === null ? null : number(row.output_tokens), cachedInputTokens: row.cached_input_tokens === null ? null : number(row.cached_input_tokens), reasoningTokens: row.reasoning_tokens === null ? null : number(row.reasoning_tokens), providerUsage: row.provider_usage_json ? parseObject(row.provider_usage_json) : null, createdAt: number(row.created_at) }; }
  private mapCycleEvent(row: SqlRow): CycleEvent { return { id: number(row.id), cycleId: String(row.cycle_id), kind: String(row.kind) as CycleEvent['kind'], payload: row.payload_json ? parseObject(row.payload_json) : null, createdAt: number(row.created_at) }; }
  private mapError(row: SqlRow): ErrorRecord { const details = row.details_json ? sanitizeError(parseObject(row.details_json)) : null; return { id: number(row.id), roomId: String(row.room_id), source: String(row.source), participantId: nullableString(row.participant_id), connectionId: nullableString(row.connection_id), cycleId: nullableString(row.cycle_id), httpStatus: row.http_status === null ? null : number(row.http_status), providerCode: nullableString(row.provider_code), message: String(row.message), details, createdAt: number(row.created_at) }; }
  private mapConnection(row: SqlRow): Connection { return { id: String(row.id), name: String(row.name), type: String(row.type), config: parseObject(row.config_json), credentialRef: nullableString(row.credential_ref), createdAt: number(row.created_at), updatedAt: number(row.updated_at) }; }
  private mapParticipantDetail(row: SqlRow): ParticipantDetail { const participant: Participant = { id: String(row.id), roomId: String(row.room_id), displayName: String(row.display_name), avatar: nullableString(row.avatar), enabled: Boolean(row.enabled), connectionId: nullableString(row.connection_id), modelId: String(row.model_id), modelOptions: parseObject(row.model_options_json), systemPrompt: String(row.system_prompt), privateMemo: String(row.private_memo), createdAt: number(row.created_at), updatedAt: number(row.updated_at) }; const runtime: ParticipantRuntime = { participantId: participant.id, observed: row.observed_thread_id === null ? null : { threadId: String(row.observed_thread_id), resNumber: number(row.observed_res) }, lastPosted: row.last_posted_thread_id === null ? null : { threadId: String(row.last_posted_thread_id), resNumber: number(row.last_posted_res) }, nextPollAt: row.next_poll_at === null ? null : number(row.next_poll_at), status: String(row.status) as RuntimeStatus, activeCycleId: nullableString(row.active_cycle_id), lastError: nullableString(row.last_error), blockedAt: row.blocked_thread_id === null ? null : { threadId: String(row.blocked_thread_id), resNumber: number(row.blocked_res) }, blockedInputSignature: nullableString(row.blocked_input_signature), permanentError: Boolean(row.permanent_error) }; return { ...participant, runtime }; }
  private mapCycle(row: SqlRow): Cycle { return { id: String(row.id), participantId: String(row.participant_id), roomId: String(row.room_id), serverRunId: String(row.server_run_id), snapshot: { threadId: String(row.snapshot_thread_id), threadNumber: number(row.snapshot_thread_number), latestResNumber: number(row.snapshot_res), maxPostId: number(row.snapshot_post_id), observedBefore: row.observed_thread_id === null ? null : { threadId: String(row.observed_thread_id), resNumber: number(row.observed_res) } }, inputSignature: String(row.input_signature), status: String(row.status) as Cycle["status"], startedAt: number(row.started_at), completedAt: row.completed_at === null ? null : number(row.completed_at), error: nullableString(row.error), participantDeleted: row.participant_deleted_at !== null && row.participant_deleted_at !== undefined, participantName: nullableString(row.participant_name) }; }
}
