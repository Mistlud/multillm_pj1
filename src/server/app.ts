import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { RoomStore, WorkerManager, type Connection, type UpdateParticipantInput } from '../core/index.js';
import { CredentialStore } from './credentials.js';
import { createAdapterResolver } from '../adapters/index.js';
import { corePrompts, previewRequest } from '../adapters/prompts.js';
import { registerSecret, sanitizeError } from '../core/redaction.js';
import { CorePromptConflictError, CorePromptValidationError } from '../core/prompt-template.js';
import { CodexManager, type CodexManagerLike } from './codex.js';
import type { AppConfig } from './config.js';

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function string(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${field} 값을 확인하세요.`);
  return value;
}
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON object가 필요합니다.');
  return value as Record<string, any>;
}
function integer(value: unknown): number { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, '번호가 올바르지 않습니다.'); return n; }
async function body(req: IncomingMessage, maxBytes = 256_000): Promise<Record<string, any>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON 요청만 지원합니다.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.'); }
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function safeConnection(connection: Connection) { const { credentialRef, ...rest } = connection; return { ...rest, hasCredential: Boolean(credentialRef) }; }
const connectionTypes = new Set(['mock', 'vertex', 'oai-compatible', 'custom-api', 'codex']);

function connectionValues(input: Record<string, any>, current?: Connection): { name: string; type: string; config: Record<string, unknown>; credential?: string } {
  const type = current ? current.type : string(input.type, '연결 유형');
  if (!connectionTypes.has(type)) throw new HttpError(400, '아직 지원하지 않는 연결 유형입니다.');
  if (current && 'type' in input && string(input.type, '연결 유형') !== current.type) throw new HttpError(400, 'Connection 유형은 수정할 수 없습니다.');
  const name = current && !('name' in input) ? current.name : string(input.name, '연결 이름');
  const configPatch = 'config' in input ? record(input.config) : {};
  const source = { ...(current?.config ?? {}), ...configPatch };
  const config: Record<string, unknown> = {};
  if (type === 'vertex') {
    config.project = string(source.project, 'GCP project');
    config.location = string(source.location ?? 'global', 'location');
    config.contextTokens = Number(source.contextTokens ?? 1048576);
  } else if (type === 'oai-compatible' || type === 'custom-api') {
    config.endpoint = string(source.endpoint, 'endpoint', 2000);
    config.contextTokens = Number(source.contextTokens);
    if ('jsonMode' in source && typeof source.jsonMode !== 'boolean') throw new HttpError(400, 'jsonMode 값을 확인하세요.');
    config.jsonMode = source.jsonMode ?? true;
  } else if (type === 'codex') {
    config.contextTokens = Number(source.contextTokens ?? 64_000);
  }
  if (type !== 'mock' && (!Number.isInteger(config.contextTokens) || Number(config.contextTokens) < 1024 || Number(config.contextTokens) > 2_000_000)) throw new HttpError(400, 'contextTokens 입력 한도를 확인하세요.');
  let credential: string | undefined;
  if ('credential' in input) {
    if (typeof input.credential !== 'string') throw new HttpError(400, '인증정보 값을 확인하세요.');
    if (input.credential.trim()) credential = string(input.credential, '인증정보', 100000);
  }
  if (credential && (type === 'mock' || type === 'codex')) throw new HttpError(400, type === 'codex' ? 'Codex Connection은 ChatGPT 구독 인증만 사용합니다.' : 'Mock Connection에는 인증정보를 저장할 수 없습니다.');
  if (credential && type === 'vertex') {
    let key: Record<string, any>;
    try { key = record(JSON.parse(credential)); } catch { throw new HttpError(400, '서비스 계정 JSON 형식을 확인하세요.'); }
    if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new HttpError(400, '서비스 계정 JSON이 필요합니다.');
  }
  if (type === 'vertex' && !credential && !current?.credentialRef) throw new HttpError(400, '서비스 계정 JSON 인증이 필요합니다.');
  return { name, type, config, credential };
}

export function createApp(config: AppConfig, options: { store?: RoomStore; onShutdown?: () => void; codexManager?: CodexManagerLike } = {}) {
  registerSecret(config.token);
  const store = options.store ?? RoomStore.open({ path: resolve(config.dataDir, 'room.sqlite') });
  const credentials = new CredentialStore(config.dataDir);
  let workers: WorkerManager;
  const codex = options.codexManager ?? new CodexManager(config.dataDir, { onLoginComplete: (connectionId) => workers.connectionUpdated(connectionId), onAuthError: (connectionId, error) => { try { const detail = error as { details?: unknown; providerCode?: string }; store.recordError({ roomId: 'main', source: 'codex/auth', participantId: null, connectionId, cycleId: null, httpStatus: null, providerCode: detail.providerCode ?? null, message: error instanceof Error ? error.message : String(error), details: detail.details }); } catch { /* Server/store may already be closed. */ } } });
  workers = new WorkerManager(store, { adapters: createAdapterResolver(credentials, { codexManager: codex }) });
  const room = store.getRoom('main') ?? store.createRoom({ id: 'main', name: 'LLM 단톡방' });
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  let closing = false;
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...addresses, config.host]);
  const validHost = (req: IncomingMessage): boolean => { try { return allowedHosts.has(new URL(`http://${req.headers.host}`).hostname); } catch { return false; } };
  const originValid = (req: IncomingMessage): boolean => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
  const authenticated = (req: IncomingMessage): boolean => {
    const raw = req.headers.authorization;
    if (raw?.startsWith('Bearer ')) { const bytes = Buffer.from(raw.slice(7)); const expected = Buffer.from(config.token); if (bytes.length === expected.length && timingSafeEqual(bytes, expected)) return true; }
    const id = /(?:^|;\s*)room_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const expires = id ? sessions.get(id) : undefined;
    if (!expires || expires < Date.now()) { if (id) sessions.delete(id); return false; }
    return true;
  };

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!validHost(req)) throw new HttpError(403, '허용되지 않은 서버 주소입니다.');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const method = req.method ?? 'GET';
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new HttpError(405, '지원하지 않는 요청 방식입니다.');
      if (method !== 'GET' && (!originValid(req) || req.headers['sec-fetch-site'] === 'cross-site')) throw new HttpError(403, '다른 사이트에서 보낸 요청은 허용하지 않습니다.');
      if (method === 'GET' && ['/','/app.js','/style.css'].includes(url.pathname)) {
        const asset = url.pathname === '/' ? ['public/index.html', 'text/html'] : url.pathname === '/style.css' ? ['public/style.css', 'text/css'] : ['dist/web/app.js', 'text/javascript'];
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(readFileSync(resolve(asset[0]!))); return;
      }
      if (url.pathname === '/api/health' && method === 'GET') { json(res, 200, { ok: !closing }); return; }
      if (url.pathname === '/api/login' && method === 'POST') {
        const ip = req.socket.remoteAddress ?? 'unknown'; const now = Date.now();
        for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
        if (attempts.size > 500) throw new HttpError(429, '잠시 후 다시 시도하세요.');
        const attempt = attempts.get(ip) ?? { count: 0, until: now + 60_000 };
        if (attempt.count >= 5) throw new HttpError(429, '로그인 시도가 많습니다. 1분 후 다시 시도하세요.');
        const input = await body(req); const token = typeof input.token === 'string' ? input.token : '';
        const expected = Buffer.from(config.token), supplied = Buffer.from(token);
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { attempt.count++; attempts.set(ip, attempt); throw new HttpError(401, '접속 토큰이 일치하지 않습니다.'); }
        attempts.delete(ip);
        for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key);
        if (sessions.size >= 100) throw new HttpError(429, '접속 세션이 많습니다.');
        const session = randomBytes(32).toString('base64url'); sessions.set(session, now + 8 * 3600_000);
        res.setHeader('Set-Cookie', `room_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        json(res, 200, { ok: true }); return;
      }
      if (!authenticated(req)) throw new HttpError(401, '접속 토큰으로 로그인하세요.');
      if (closing) throw new HttpError(503, '서버가 종료 중입니다.');
      if (url.pathname === '/api/logout' && method === 'POST') {
        const id = /(?:^|;\s*)room_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1]; if (id) sessions.delete(id);
        res.setHeader('Set-Cookie', 'room_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); json(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/api/state' && method === 'GET') {
        const current = store.getCurrentThread(room.id)!;
        const hasNotificationGeneration = url.searchParams.has('notificationGeneration'), hasNotificationAfter = url.searchParams.has('notificationAfter');
        if (hasNotificationGeneration !== hasNotificationAfter) throw new HttpError(400, '알림 커서는 generation과 after를 함께 보내야 합니다.');
        let notificationCursor: { generation: string; after: number } | undefined;
        if (hasNotificationGeneration && hasNotificationAfter) {
          const generation = url.searchParams.get('notificationGeneration'), after = url.searchParams.get('notificationAfter');
          if (!generation || generation.length > 128 || !/^[A-Za-z0-9_-]+$/.test(generation) || !after || !/^\d+$/.test(after)) throw new HttpError(400, '알림 커서 값을 확인하세요.');
          const afterNumber = Number(after); if (!Number.isSafeInteger(afterNumber) || afterNumber < 0) throw new HttpError(400, '알림 커서 값을 확인하세요.');
          notificationCursor = { generation, after: afterNumber };
        }
        json(res, 200, { room: store.getRoom(room.id), thread: current, messages: store.listThreadRes(current.id), participants: store.listParticipants(room.id).map((participant) => ({ ...participant, cycleState: store.getParticipantCycleState(participant) })), participantMemos: store.listParticipantMemos(room.id), connections: store.listConnections().map(safeConnection), posts: store.listPosts(room.id).map(({ body: _body, ...post }) => post), threads: store.listThreads(room.id), usage: store.getUsageSummary({ roomId: room.id }), notifications: store.getNotifications(room.id, notificationCursor), limits: store.limits, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, lanAddresses: addresses.map((ip) => `http://${ip}:${config.port}`) }); return;
      }
      if (url.pathname === '/api/participant-memos' && method === 'GET') { json(res, 200, store.listParticipantMemos(room.id, url.searchParams.get('includeDeleted') === '1')); return; }
      if (url.pathname === '/api/dashboard' && method === 'GET') {
        if (url.searchParams.has('from') || url.searchParams.has('to')) throw new HttpError(400, '대시보드 기간은 period=today|7d|30d으로만 지정하세요.');
        const period = url.searchParams.get('period') ?? '7d'; const mode = url.searchParams.get('mode') ?? 'real';
        if (period !== 'today' && period !== '7d' && period !== '30d') throw new HttpError(400, 'period는 today, 7d, 30d 중 하나여야 합니다.');
        if (mode !== 'real' && mode !== 'mock') throw new HttpError(400, 'mode는 real 또는 mock이어야 합니다.');
        const participantId = url.searchParams.get('participantId') || undefined, connectionId = url.searchParams.get('connectionId') || undefined;
        json(res, 200, store.getDashboard(room.id, { period, mode, participantId, connectionId })); return;
      }
      if (url.pathname === '/api/prompts' && method === 'GET') { json(res, 200, corePrompts(store.getCorePrompt(room.id))); return; }
      if (url.pathname === '/api/prompts' && method === 'PATCH') {
        const input = await body(req, 1_300_000);
        if (typeof input.template !== 'string' || typeof input.expectedTemplate !== 'string') throw new HttpError(400, '공통 프롬프트와 이전 저장 내용을 확인하세요.');
        try { if (store.setCorePrompt(room.id, input.template, input.expectedTemplate)) workers.roomPromptUpdated(room.id); }
        catch (error) {
          if (error instanceof CorePromptConflictError) throw new HttpError(409, error.message);
          if (error instanceof CorePromptValidationError) throw new HttpError(400, error.message);
          throw error;
        }
        json(res, 200, corePrompts(store.getCorePrompt(room.id))); return;
      }
      const previewRoute = /^\/api\/participants\/([^/]+)\/preview$/.exec(url.pathname);
      if (previewRoute && method === 'GET') {
        const preview = store.previewParticipant(previewRoute[1]!);
        if (!preview || preview.participant.roomId !== room.id) throw new HttpError(404, '참가자가 없습니다.');
        json(res, 200, previewRequest({ participant: preview.participant, input: preview.input, history: [], signal: new AbortController().signal }, preview.connection)); return;
      }
      if (url.pathname === '/api/threads/rollover' && method === 'POST') { await body(req); json(res, 200, store.forceRollover(room.id)); return; }
      if (url.pathname === '/api/threads/delete' && method === 'POST') {
        const input = await body(req); if (!Array.isArray(input.numbers) || !input.numbers.length || input.numbers.length > 500) throw new HttpError(400, '종료된 불판을 선택하세요.');
        const numbers = [...new Set(input.numbers.map(integer))];
        if (numbers.some((n) => store.getThread(room.id, n)?.status !== 'closed')) throw new HttpError(400, '종료된 불판만 삭제할 수 있습니다.');
        json(res, 200, { deleted: store.deleteThreads(room.id, numbers) }); return;
      }
      if (url.pathname === '/api/reset' && method === 'POST') { const input = await body(req); if (input.confirmation !== 'HARD RESET') throw new HttpError(400, 'HARD RESET을 정확히 입력하세요.'); workers.hardReset(room.id); json(res, 200, { ok: true, thread: store.getCurrentThread(room.id) }); return; }
      const filters = () => ({ participantId: url.searchParams.get('participantId') || undefined, connectionId: url.searchParams.get('connectionId') || undefined, cycleId: url.searchParams.get('cycleId') || undefined, limit: url.searchParams.has('limit') ? integer(url.searchParams.get('limit')) : undefined, beforeId: url.searchParams.has('beforeId') ? integer(url.searchParams.get('beforeId')) : undefined, beforeStartedAt: url.searchParams.has('beforeStartedAt') ? integer(url.searchParams.get('beforeStartedAt')) : undefined });
      if (url.pathname === '/api/usage' && method === 'GET') { json(res, 200, { records: store.listUsage(room.id, filters()), ...store.getUsageDetails(room.id) }); return; }
      if (url.pathname === '/api/cycles' && method === 'GET') { json(res, 200, store.listCycles(room.id, filters()).map(({ inputSignature: _signature, serverRunId: _run, ...cycle }) => ({ ...cycle, ...store.getCycleOverview(cycle.id) }))); return; }
      if (url.pathname.startsWith('/api/cycles/') && method === 'GET') { const detail = store.getCycleDetail(room.id, url.pathname.split('/').at(-1)!); if (!detail) throw new HttpError(404, 'Cycle이 없습니다.'); const { inputSignature: _signature, serverRunId: _run, ...cycle } = detail.cycle; json(res, 200, { ...detail, cycle }); return; }
      if (url.pathname === '/api/errors' && method === 'GET') { json(res, 200, store.listErrors(room.id, filters())); return; }
      if (/^\/api\/errors\/\d+$/.test(url.pathname) && method === 'GET') { const error = store.getError(room.id, integer(url.pathname.split('/').at(-1))); if (!error) throw new HttpError(404, '오류 기록이 없습니다.'); json(res, 200, error); return; }
      if (url.pathname === '/api/errors' && method === 'DELETE') { json(res, 200, { deleted: store.clearErrors(room.id) }); return; }
      if (url.pathname === '/api/errors' && method === 'POST') { const input = await body(req); const entry = store.recordError({ roomId: room.id, source: 'browser', participantId: null, connectionId: null, cycleId: null, httpStatus: null, providerCode: null, message: string(input.message, '오류 메시지', 32000), details: sanitizeError(input.details) }); json(res, 201, { id: entry.id }); return; }
      if (url.pathname === '/api/res' && method === 'POST') {
        const input = await body(req); const message = string(input.message, '메시지', 20000);
        json(res, 201, store.appendRes({ roomId: room.id, author: { type: 'admin', id: null, displayName: '관리자' }, body: message })); return;
      }
      if (url.pathname === '/api/posts' && method === 'POST') {
        const input = await body(req);
        json(res, 201, store.appendPostWithReference({ roomId: room.id, author: { type: 'admin', id: null, displayName: '관리자' }, title: string(input.title, '제목', 300), body: string(input.body, '본문', 100000), message: string(input.message, '소개', 20000) })); return;
      }
      if (url.pathname.startsWith('/api/posts/') && method === 'GET') {
        const post = store.readPost(room.id, integer(url.pathname.split('/').at(-1))); if (!post) throw new HttpError(404, '게시글이 없습니다.'); json(res, 200, post); return;
      }
      if (/^\/api\/posts\/\d+$/.test(url.pathname) && method === 'DELETE') { if (!store.deletePost(room.id, integer(url.pathname.split('/').at(-1)))) throw new HttpError(404, '게시글이 없습니다.'); json(res, 200, { ok: true }); return; }
      if (url.pathname.startsWith('/api/threads/') && method === 'GET') {
        const thread = store.getThread(room.id, integer(url.pathname.split('/').at(-1))); if (!thread) throw new HttpError(404, '불판이 없습니다.'); json(res, 200, { thread, messages: store.listThreadRes(thread.id) }); return;
      }
      if (url.pathname === '/api/archive' && method === 'GET') { const query = url.searchParams.get('q') ?? ''; if (query.length > 300) throw new HttpError(400, '검색어가 너무 깁니다.'); json(res, 200, store.searchArchive(room.id, query)); return; }
      if (url.pathname === '/api/connections' && method === 'POST') {
        const input = await body(req); const values = connectionValues(input);
        let credentialRef: string | null = null;
        let created: Connection;
        try {
          if (values.credential) credentialRef = await credentials.save(values.credential);
          created = store.addConnection({ name: values.name, type: values.type, config: values.config, credentialRef });
        } catch (error) {
          if (credentialRef) credentials.delete(credentialRef);
          throw error;
        }
        json(res, 201, safeConnection(created)); return;
      }
      const codexRoute = /^\/api\/connections\/([^/]+)\/codex\/(status|login|cancel)$/.exec(url.pathname);
      if (codexRoute) {
        const id = codexRoute[1]!; const action = codexRoute[2]!; const connection = store.getConnection(id);
        if (!connection) throw new HttpError(404, 'Connection이 없습니다.');
        if (connection.type !== 'codex') throw new HttpError(400, 'Codex Connection이 아닙니다.');
        if (action === 'status' && method === 'GET') { json(res, 200, await codex.checkStatus(connection)); return; }
        if (action === 'login' && method === 'POST') { await body(req); try { json(res, 200, await codex.startLogin(connection)); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Codex 인증을 시작하지 못했습니다.'); } return; }
        if (action === 'cancel' && method === 'POST') { await body(req); await codex.cancelLogin(connection.id); json(res, 200, { ok: true }); return; }
      }
      if (url.pathname.startsWith('/api/connections/') && method === 'PATCH') {
        const id = url.pathname.split('/').at(-1)!; const input = await body(req); const current = store.getConnection(id);
        if (!current) throw new HttpError(404, 'Connection이 없습니다.');
        const values = connectionValues(input, current);
        let credentialRef: string | undefined;
        let updated: Connection;
        let settingsChanged = false;
        try {
          if (values.credential) credentialRef = await credentials.save(values.credential);
          const latest = store.getConnection(id);
          if (!latest) throw new HttpError(404, 'Connection이 없습니다.');
          const committed = connectionValues(input, latest);
          updated = store.updateConnection(id, { name: 'name' in input ? committed.name : undefined, type: latest.type, config: 'config' in input ? committed.config : undefined, credentialRef });
          settingsChanged = JSON.stringify(updated.config) !== JSON.stringify(latest.config) || updated.credentialRef !== latest.credentialRef;
        } catch (error) {
          if (credentialRef) credentials.delete(credentialRef);
          throw error;
        }
        if (settingsChanged) workers.connectionUpdated(id);
        json(res, 200, safeConnection(updated)); return;
      }
      if (url.pathname.startsWith('/api/connections/') && method === 'DELETE') {
        const id = url.pathname.split('/').at(-1)!;
        const connection = store.getConnection(id);
        let deleted: ReturnType<RoomStore["deleteConnection"]>;
        try { deleted = store.deleteConnection(id); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/still referenced/.test(message)) throw new HttpError(409, '참가자 또는 진행 중 호출에서 사용하는 Connection은 삭제할 수 없습니다.');
          if (/not found/.test(message)) throw new HttpError(404, 'Connection이 없습니다.');
          throw error;
        }
        let cleanupWarning = false;
        for (const ref of deleted.credentialRefsToCleanup) {
          try { credentials.delete(ref); } catch { cleanupWarning = true; }
        }
        if (connection?.type === 'codex') { try { await codex.remove(connection); } catch { cleanupWarning = true; } }
        json(res, 200, { ok: true, cleanupWarning }); return;
      }
      if (url.pathname === '/api/participants' && method === 'POST') {
        const input = await body(req); const options = record(input.modelOptions ?? {});
        const connectionId = string(input.connectionId, 'Connection'); const connection = store.getConnection(connectionId); if (!connection) throw new HttpError(400, 'Connection이 없습니다.');
        validateOptions(options, connection);
        if ('systemPrompt' in input && (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 20000)) throw new HttpError(400, 'system prompt를 확인하세요.');
        const participant = store.addParticipant({ roomId: room.id, displayName: string(input.displayName, '표시 이름', 80), modelId: string(input.modelId, '모델 ID'), connectionId, enabled: false, systemPrompt: input.systemPrompt ?? '', modelOptions: options });
        json(res, 201, participant); return;
      }
      if (url.pathname.startsWith('/api/participants/') && method === 'PATCH') {
        const id = url.pathname.split('/').at(-1)!; const input = await body(req); const participant = store.getParticipant(id);
        if (!participant || participant.roomId !== room.id) throw new HttpError(404, '참가자가 없습니다.');
        const patch: UpdateParticipantInput = {};
        if ('displayName' in input) patch.displayName = string(input.displayName, '표시 이름', 80);
        if ('modelId' in input) patch.modelId = string(input.modelId, '모델 ID');
        const requestedConnection = 'connectionId' in input ? store.getConnection(string(input.connectionId, 'Connection')) : store.getConnection(participant.connectionId ?? '');
        if ('connectionId' in input) { patch.connectionId = string(input.connectionId, 'Connection'); if (!requestedConnection) throw new HttpError(400, 'Connection이 없습니다.'); }
        if ('systemPrompt' in input) { if (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 20000) throw new HttpError(400, 'system prompt를 확인하세요.'); patch.systemPrompt = input.systemPrompt; }
        if ('modelOptions' in input) { patch.modelOptions = record(input.modelOptions); validateOptions(patch.modelOptions, requestedConnection ?? undefined); }
        else if ('connectionId' in input) validateOptions(participant.modelOptions, requestedConnection ?? undefined);
        if (Object.keys(patch).length) store.updateParticipant(id, patch);
        if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled는 boolean이어야 합니다.'); workers.setEnabled(id, input.enabled); }
        else if (participant.enabled) workers.schedule(id);
        json(res, 200, store.getParticipant(id)); return;
      }
      const participantMemoRoute = /^\/api\/participants\/([^/]+)\/memo$/.exec(url.pathname);
      if (participantMemoRoute && method === 'DELETE') {
        try { store.deleteDeletedParticipantMemo(room.id, participantMemoRoute[1]!); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/not found/.test(message)) throw new HttpError(404, '삭제된 참가자가 없습니다.');
          if (/not deleted/.test(message)) throw new HttpError(409, '삭제된 참가자의 메모만 비울 수 있습니다.');
          throw error;
        }
        json(res, 200, { ok: true }); return;
      }
      if (url.pathname.startsWith('/api/participants/') && method === 'DELETE') {
        const id = url.pathname.split('/').at(-1)!; const participant = store.getParticipant(id);
        if (!participant || participant.roomId !== room.id) throw new HttpError(404, '참가자가 없습니다.');
        try { store.deleteParticipant(id); }
        catch (error) {
          if (error instanceof Error && /active cycle/.test(error.message)) throw new HttpError(409, '진행 중인 호출이 있어 참가자를 삭제할 수 없습니다.');
          throw error;
        }
        workers.removeParticipant(id);
        json(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/api/shutdown' && method === 'POST') { json(res, 200, { ok: true }); setImmediate(() => { shutdown(); options.onShutdown?.(); }); return; }
      throw new HttpError(404, '요청한 경로가 없습니다.');
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      let errorId: number | undefined;
      try { const parts = (req.url ?? '').split('?')[0]!.split('/'); const participant = parts[2] === 'participants' ? store.getParticipant(parts[3] ?? '') : null; errorId = store.recordError({ roomId: room.id, source: `${req.method ?? 'GET'} ${parts.slice(0, 3).join('/')}`, participantId: participant?.id ?? null, connectionId: participant?.connectionId ?? (parts[2] === 'connections' && store.getConnection(parts[3] ?? '') ? parts[3]! : null), cycleId: null, httpStatus: error instanceof HttpError ? error.status : 500, providerCode: null, message: error instanceof Error ? error.message : String(error), details: null }).id; } catch { /* DB failures must still return the original HTTP failure. */ }
      if (error instanceof HttpError) json(res, error.status, { error: sanitizeError(error.message), errorId });
      else {
        const message = error instanceof Error ? error.message : '';
        if (/exceeds|token|message is|required|not found|archive query is invalid/i.test(message)) json(res, 400, { error: /exceeds|token/i.test(message) ? '길이 제한을 초과했습니다. 긴 글은 Big Board를 사용하세요.' : '입력값을 확인하세요.', errorId });
        else json(res, 500, { error: '요청 처리에 실패했습니다. 서버 상태를 확인하세요.', errorId });
      }
    }
  });
  function shutdown(): void { if (closing) return; closing = true; workers.stop(); void codex.stop(); server.close(); server.closeAllConnections(); }
  server.on('close', () => { workers.stop(); void codex.stop(); if (!options.store) store.close(); });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return { server, store, workers, room, shutdown, startWorkers: () => workers.start() };
}

function validateOptions(options: Record<string, unknown>, connection?: Connection) {
  const allowed = new Set(['outputTokens', 'contextTokens', 'thinkingLevel', 'mockAction', 'reasoningEffort']);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new HttpError(400, '지원하지 않는 모델 옵션입니다.');
  if ('outputTokens' in options && (!Number.isInteger(options.outputTokens) || Number(options.outputTokens) < 256 || Number(options.outputTokens) > 32768)) throw new HttpError(400, 'outputTokens는 256~32768이어야 합니다.');
  if ('contextTokens' in options && (!Number.isInteger(options.contextTokens) || Number(options.contextTokens) < 1024 || Number(options.contextTokens) > 2_000_000)) throw new HttpError(400, 'contextTokens를 확인하세요.');
  if ('thinkingLevel' in options && (typeof options.thinkingLevel !== 'string' || options.thinkingLevel.length > 200)) throw new HttpError(400, 'thinkingLevel은 텍스트로 입력하세요.');
  if ('mockAction' in options && !['wait','reply'].includes(String(options.mockAction))) throw new HttpError(400, 'mockAction을 확인하세요.');
  if ('reasoningEffort' in options && (typeof options.reasoningEffort !== 'string' || options.reasoningEffort.length > 200)) throw new HttpError(400, 'reasoningEffort는 텍스트로 입력하세요.');
  if ('thinkingLevel' in options && connection?.type !== 'vertex') throw new HttpError(400, 'thinkingLevel은 Vertex Connection에서만 지원합니다.');
  if (connection?.type === 'codex') {
    if ('outputTokens' in options || 'contextTokens' in options || 'thinkingLevel' in options || 'mockAction' in options) throw new HttpError(400, 'Codex는 reasoningEffort만 지원합니다.');
  } else if ('reasoningEffort' in options) throw new HttpError(400, 'reasoningEffort는 Codex Connection에서만 지원합니다.');
}
