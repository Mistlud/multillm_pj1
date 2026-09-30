import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { RoomStore, WorkerManager, type Connection, type UpdateParticipantInput } from '../core/index.js';
import { CredentialStore } from './credentials.js';
import { createAdapterResolver } from '../adapters/index.js';
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
async function body(req: IncomingMessage): Promise<Record<string, any>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON 요청만 지원합니다.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 256_000) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.'); }
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function safeConnection(connection: Connection) { const { credentialRef, ...rest } = connection; return { ...rest, hasCredential: Boolean(credentialRef) }; }

export function createApp(config: AppConfig, options: { store?: RoomStore; onShutdown?: () => void } = {}) {
  const store = options.store ?? RoomStore.open({ path: resolve(config.dataDir, 'room.sqlite') });
  const credentials = new CredentialStore(config.dataDir);
  const workers = new WorkerManager(store, { adapters: createAdapterResolver(credentials) });
  const room = store.getRoom('main') ?? store.createRoom({ id: 'main', name: 'LLM 단톡방' });
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  let closing = false;
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...addresses, config.host]);
  const apiTypes = new Set(['mock', 'vertex', 'oai-compatible', 'custom-api']);
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
      if (!['GET', 'POST', 'PATCH'].includes(method)) throw new HttpError(405, '지원하지 않는 요청 방식입니다.');
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
        json(res, 200, { room: store.getRoom(room.id), thread: current, messages: store.listThreadRes(current.id), participants: store.listParticipants(room.id), connections: store.listConnections().map(safeConnection), posts: store.listPosts(room.id).map(({ body: _body, ...post }) => post), threads: store.listThreads(room.id), usage: store.getUsageSummary({ roomId: room.id }), limits: store.limits, lanAddresses: addresses.map((ip) => `http://${ip}:${config.port}`) }); return;
      }
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
      if (url.pathname.startsWith('/api/threads/') && method === 'GET') {
        const thread = store.getThread(room.id, integer(url.pathname.split('/').at(-1))); if (!thread) throw new HttpError(404, '불판이 없습니다.'); json(res, 200, { thread, messages: store.listThreadRes(thread.id) }); return;
      }
      if (url.pathname === '/api/archive' && method === 'GET') { const query = url.searchParams.get('q') ?? ''; if (query.length > 300) throw new HttpError(400, '검색어가 너무 깁니다.'); json(res, 200, store.searchArchive(room.id, query)); return; }
      if (url.pathname === '/api/connections' && method === 'POST') {
        const input = await body(req); const type = string(input.type, '연결 유형');
        if (!apiTypes.has(type)) throw new HttpError(400, '아직 지원하지 않는 연결 유형입니다.');
        const cfg = record(input.config ?? {}); const safeConfig: Record<string, unknown> = {};
        if (type === 'vertex') { safeConfig.project = string(cfg.project, 'GCP project'); safeConfig.location = string(cfg.location ?? 'global', 'location'); safeConfig.contextTokens = Number(cfg.contextTokens ?? 1048576); }
        if (type === 'oai-compatible' || type === 'custom-api') { safeConfig.endpoint = string(cfg.endpoint, 'endpoint', 2000); safeConfig.contextTokens = Number(cfg.contextTokens); safeConfig.jsonMode = cfg.jsonMode !== false; }
        if (type !== 'mock' && (!Number.isInteger(safeConfig.contextTokens) || Number(safeConfig.contextTokens) < 1024 || Number(safeConfig.contextTokens) > 2_000_000)) throw new HttpError(400, 'contextTokens 입력 한도를 확인하세요.');
        let credentialRef: string | null = null;
        if (input.credential) {
          const secret = string(input.credential, '인증정보', 100000);
          if (type === 'vertex') { let key: Record<string, any>; try { key = record(JSON.parse(secret)); } catch { throw new HttpError(400, '서비스 계정 JSON 형식을 확인하세요.'); } if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new HttpError(400, '서비스 계정 JSON이 필요합니다.'); }
          credentialRef = await credentials.save(secret);
        }
        if (type === 'vertex' && !credentialRef) throw new HttpError(400, '서비스 계정 JSON 인증이 필요합니다.');
        json(res, 201, safeConnection(store.addConnection({ name: string(input.name, '연결 이름'), type, config: safeConfig, credentialRef }))); return;
      }
      if (url.pathname === '/api/participants' && method === 'POST') {
        const input = await body(req); const options = record(input.modelOptions ?? {});
        const connectionId = string(input.connectionId, 'Connection'); if (!store.getConnection(connectionId)) throw new HttpError(400, 'Connection이 없습니다.');
        validateOptions(options);
        const participant = store.addParticipant({ roomId: room.id, displayName: string(input.displayName, '표시 이름', 80), modelId: string(input.modelId, '모델 ID'), connectionId, enabled: false, systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt.slice(0, 20000) : '', modelOptions: options });
        json(res, 201, participant); return;
      }
      if (url.pathname.startsWith('/api/participants/') && method === 'PATCH') {
        const id = url.pathname.split('/').at(-1)!; const input = await body(req); const participant = store.getParticipant(id);
        if (!participant || participant.roomId !== room.id) throw new HttpError(404, '참가자가 없습니다.');
        const patch: UpdateParticipantInput = {};
        if ('displayName' in input) patch.displayName = string(input.displayName, '표시 이름', 80);
        if ('modelId' in input) patch.modelId = string(input.modelId, '모델 ID');
        if ('connectionId' in input) { patch.connectionId = string(input.connectionId, 'Connection'); if (!store.getConnection(patch.connectionId)) throw new HttpError(400, 'Connection이 없습니다.'); }
        if ('systemPrompt' in input) { if (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 20000) throw new HttpError(400, 'system prompt를 확인하세요.'); patch.systemPrompt = input.systemPrompt; }
        if ('modelOptions' in input) { patch.modelOptions = record(input.modelOptions); validateOptions(patch.modelOptions); }
        if (Object.keys(patch).length) store.updateParticipant(id, patch);
        if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled는 boolean이어야 합니다.'); workers.setEnabled(id, input.enabled); }
        else if (participant.enabled) workers.schedule(id);
        json(res, 200, store.getParticipant(id)); return;
      }
      if (url.pathname === '/api/shutdown' && method === 'POST') { json(res, 200, { ok: true }); setImmediate(() => { shutdown(); options.onShutdown?.(); }); return; }
      throw new HttpError(404, '요청한 경로가 없습니다.');
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (error instanceof HttpError) json(res, error.status, { error: error.message });
      else {
        const message = error instanceof Error ? error.message : '';
        if (/exceeds|token|message is|required|not found|archive query is invalid/i.test(message)) json(res, 400, { error: /exceeds|token/i.test(message) ? '길이 제한을 초과했습니다. 긴 글은 Big Board를 사용하세요.' : '입력값을 확인하세요.' });
        else json(res, 500, { error: '요청 처리에 실패했습니다. 서버 상태를 확인하세요.' });
      }
    }
  });
  function shutdown(): void { if (closing) return; closing = true; workers.stop(); server.close(); server.closeAllConnections(); }
  server.on('close', () => { workers.stop(); if (!options.store) store.close(); });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return { server, store, workers, room, shutdown, startWorkers: () => workers.start() };
}

function validateOptions(options: Record<string, unknown>) {
  const allowed = new Set(['outputTokens', 'contextTokens', 'thinkingLevel', 'mockAction']);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new HttpError(400, '지원하지 않는 모델 옵션입니다.');
  if ('outputTokens' in options && (!Number.isInteger(options.outputTokens) || Number(options.outputTokens) < 256 || Number(options.outputTokens) > 32768)) throw new HttpError(400, 'outputTokens는 256~32768이어야 합니다.');
  if ('contextTokens' in options && (!Number.isInteger(options.contextTokens) || Number(options.contextTokens) < 1024 || Number(options.contextTokens) > 2_000_000)) throw new HttpError(400, 'contextTokens를 확인하세요.');
  if ('thinkingLevel' in options && !['LOW','MEDIUM','HIGH'].includes(String(options.thinkingLevel))) throw new HttpError(400, 'thinkingLevel을 확인하세요.');
  if ('mockAction' in options && !['wait','reply'].includes(String(options.mockAction))) throw new HttpError(400, 'mockAction을 확인하세요.');
}
