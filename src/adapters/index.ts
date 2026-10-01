import { GoogleAuth } from 'google-auth-library';
import type { AdapterRequest, ActionResult, Connection, ParticipantAdapter, AdapterResolver, AdapterUsage } from '../core/index.js';
import { AdapterError as CoreAdapterError } from '../core/index.js';
import type { CredentialStore } from '../server/credentials.js';
import type { CodexManagerLike } from '../server/codex.js';
import { CodexAdapter } from './codex.js';
import { registerSecret, sanitizeError } from '../core/redaction.js';
import { buildPrompts, vertexRequest, compatibleRequest } from './prompts.js';
export { ACTION_SCHEMA, PROTOCOL, buildPrompts } from './prompts.js';

export class AdapterError extends CoreAdapterError {
  constructor(message: string, permanent = false, retryAfterMs?: number, usage?: AdapterUsage, inputBlocked = false, metadata: { httpStatus?: number; providerCode?: string; details?: unknown } = {}) { super(sanitizeError(message), { permanent, retryAfterMs, usage, inputBlocked, ...metadata }); }
}

function parseAction(text: string): unknown {
  const value = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch { throw new AdapterError('모델이 유효한 JSON action을 반환하지 않았습니다.'); }
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const seconds = retry ? Number(retry) : NaN;
    const retryAt = retry ? Date.parse(retry) : NaN;
    const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
    const raw = await response.text().catch(() => ''); let details: any;
    try { details = JSON.parse(raw); } catch { details = raw.slice(0, 32000); }
    const safe = sanitizeError(details); const providerError = safe?.error ?? safe;
    const message = typeof providerError?.message === 'string' ? providerError.message : typeof safe === 'string' && safe ? safe : `모델 요청 실패 (HTTP ${response.status})`;
    throw new AdapterError(message, [400, 401, 403, 404].includes(response.status), delay, undefined, false, { httpStatus: response.status, providerCode: providerError?.code === undefined ? undefined : String(providerError.code), details: safe });
  }
  try { return await response.json() as Record<string, any>; } catch { throw new AdapterError('모델 응답 형식이 올바르지 않습니다.'); }
}

function outputBudget(request: AdapterRequest): number {
  const value = request.participant.modelOptions.outputTokens ?? 4096;
  if (!Number.isInteger(value) || Number(value) < 256 || Number(value) > 32768) throw new AdapterError('outputTokens는 256~32768 사이 정수여야 합니다.', true);
  return Number(value);
}
function contextBudget(request: AdapterRequest, connection: Connection): number {
  const value = request.participant.modelOptions.contextTokens ?? connection.config.contextTokens;
  if (!Number.isInteger(value) || Number(value) < 1024 || Number(value) > 2_000_000) throw new AdapterError('이 연결의 contextTokens 입력 한도를 설정하세요.', true);
  return Number(value);
}

/** Conservative UTF-8 byte bound, including protocol and output reserve; never truncates. */
function checkBudget(request: AdapterRequest, budget: number): void {
  const prompts = buildPrompts(request);
  if (Buffer.byteLength(prompts.system + prompts.user, 'utf8') + outputBudget(request) + 1024 > budget) {
    throw new AdapterError('모델 입력 한도를 초과했습니다. 자동 절단하지 않습니다.', false, undefined, undefined, true);
  }
}

class MockAdapter implements ParticipantAdapter {
  async run(request: AdapterRequest): Promise<ActionResult> {
    if (request.signal.aborted) throw new AdapterError('요청이 중단됐습니다.');
    const prompts = buildPrompts(request);
    const mode = request.participant.modelOptions.mockAction ?? 'reply';
    const action = mode === 'wait' ? { action: 'wait' } : { action: 'reply', message: `새 글을 확인했어요. (${request.input.currentThread.number}번 불판)` };
    return { action, usage: { inputTokens: Buffer.byteLength(prompts.user), outputTokens: 20, raw: { simulated: true } } };
  }
}

class VertexAdapter implements ParticipantAdapter {
  private auth?: GoogleAuth;
  constructor(private connection: Connection, private credentials: CredentialStore) {}
  async run(request: AdapterRequest): Promise<ActionResult> {
    const config = this.connection.config;
    const project = String(config.project ?? '');
    const location = String(config.location ?? 'global');
    const model = request.participant.modelId;
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(project) || !/^[a-z0-9-]+$/.test(location) || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new AdapterError('Vertex project/location/model 설정을 확인하세요.', true);
    checkBudget(request, model === 'gemini-3.8-flash' ? 1_048_576 : contextBudget(request, this.connection));
    if (!this.connection.credentialRef) throw new AdapterError('Vertex 서비스 계정 JSON 인증을 등록하세요.', true);
    let token: string | null;
    try {
      if (!this.auth) this.auth = new GoogleAuth({ credentials: JSON.parse(await this.credentials.read(this.connection.credentialRef)), scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
      token = (await this.auth.getAccessToken()) ?? null;
    } catch { throw new AdapterError('Vertex 서비스 계정 인증에 실패했습니다.', true); }
    if (!token) throw new AdapterError('Vertex 액세스 토큰을 얻지 못했습니다.', true);
    registerSecret(token);
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
    const data = await responseJson(await fetch(url, { method: 'POST', signal: request.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(vertexRequest(request, outputBudget(request))) }));
    const metadata = data.usageMetadata ?? {};
    const usage: AdapterUsage = { inputTokens: metadata.promptTokenCount, outputTokens: metadata.candidatesTokenCount === undefined && metadata.thoughtsTokenCount === undefined ? undefined : (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0), cachedInputTokens: metadata.cachedContentTokenCount, reasoningTokens: metadata.thoughtsTokenCount, raw: metadata };
    const text = (data.candidates?.[0]?.content?.parts ?? []).filter((part: any) => !part.thought).map((part: any) => part.text ?? '').join('');
    try { return { action: parseAction(text), usage }; } catch { throw new AdapterError('Vertex 응답에서 유효한 action을 읽지 못했습니다.', false, undefined, usage); }
  }
}

class CompatibleAdapter implements ParticipantAdapter {
  constructor(private connection: Connection, private credentials: CredentialStore) {}
  async run(request: AdapterRequest): Promise<ActionResult> {
    checkBudget(request, contextBudget(request, this.connection));
    let url: URL;
    try { const base = String(this.connection.config.endpoint ?? '').replace(/\/$/, ''); url = new URL(base.endsWith('/chat/completions') ? base : `${base}/chat/completions`); } catch { throw new AdapterError('호환 API endpoint를 확인하세요.', true); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AdapterError('endpoint는 인증정보·query 없는 HTTP(S) 주소여야 합니다.', true);
    const key = this.connection.credentialRef ? await this.credentials.read(this.connection.credentialRef) : null;
    const body = compatibleRequest(request, this.connection, outputBudget(request));
    const data = await responseJson(await fetch(url, { method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }));
    const metadata = data.usage ?? {};
    const usage: AdapterUsage = { requestId: data.id, inputTokens: metadata.prompt_tokens, outputTokens: metadata.completion_tokens, cachedInputTokens: metadata.prompt_tokens_details?.cached_tokens, reasoningTokens: metadata.completion_tokens_details?.reasoning_tokens, raw: metadata };
    try { return { action: parseAction(data.choices?.[0]?.message?.content ?? ''), usage }; } catch { throw new AdapterError('호환 API 응답에서 유효한 action을 읽지 못했습니다.', false, undefined, usage); }
  }
}

export function createAdapterResolver(credentials: CredentialStore, options: { codexManager?: CodexManagerLike } = {}): AdapterResolver {
  return (participant, connection) => {
    if (!connection) return undefined;
    let adapter: ParticipantAdapter;
    if (connection.type === 'mock') adapter = new MockAdapter();
    else if (connection.type === 'vertex') adapter = new VertexAdapter(connection, credentials);
    else if (connection.type === 'oai-compatible' || connection.type === 'custom-api') adapter = new CompatibleAdapter(connection, credentials);
    else if (connection.type === 'codex' && options.codexManager) adapter = new CodexAdapter(connection, options.codexManager);
    else return undefined;
    const context = connection.type === 'vertex' && participant.modelId === 'gemini-3.8-flash' ? 1_048_576 : Number(participant.modelOptions.contextTokens ?? connection.config.contextTokens ?? (connection.type === 'mock' ? 64_000 : 0));
    const reserve = connection.type === 'codex' ? 4096 : Number(participant.modelOptions.outputTokens ?? 4096);
    return {
      inputBudget: { maxInputTokens: Number.isFinite(context) ? context : 0, outputReserveTokens: Number.isFinite(reserve) ? reserve + 1024 : 4096, countInputTokens(request) { const prompt = buildPrompts(request); return Buffer.byteLength(prompt.system + prompt.user, 'utf8'); } },
      run: (request) => adapter.run(request),
      dispose: () => adapter.dispose?.(),
    };
  };
}
