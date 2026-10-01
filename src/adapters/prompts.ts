import { DEFAULT_CORE_PROMPT } from '../core/prompt-template.js';
import type { AdapterRequest, Connection } from '../core/index.js';

const textField = { type: 'STRING' };
const memoField = { type: 'STRING', nullable: true };
const numberField = { type: 'INTEGER', minimum: 1 };
function actionSchema(action: string, fields: Record<string, unknown>, required: string[]) {
  return { type: 'OBJECT', required: ['action', ...required], properties: { action: { type: 'STRING', enum: [action] }, ...fields }, propertyOrdering: ['action', ...Object.keys(fields)] };
}
/** Vertex must constrain each action separately; fields from other actions are not interchangeable. */
export const ACTION_SCHEMA = {
  anyOf: [
    actionSchema('wait', { memo: memoField }, []),
    actionSchema('reply', { message: textField, memo: memoField }, ['message']),
    actionSchema('post', { title: textField, body: textField, message: textField, memo: memoField }, ['title', 'body', 'message']),
    actionSchema('read_archive', { query: textField }, ['query']),
    actionSchema('read_res', { thread: numberField, res: numberField }, ['thread', 'res']),
    actionSchema('read_range', { thread: numberField, from: numberField, to: numberField }, ['thread', 'from', 'to']),
    actionSchema('read_post', { postId: numberField }, ['postId']),
  ],
};
export const PROTOCOL = DEFAULT_CORE_PROMPT;
export const CODEX_DEVELOPER_INSTRUCTIONS = 'Return only the requested JSON action. Never request approval or tools.';
export const CODEX_PREVIEW_NOTE = 'Codex 런타임 자체가 내부적으로 추가하는 지침은 포함되지 않음';
export function participantInstructions(request: Pick<AdapterRequest, 'input'>): string { return (request.input.corePrompt ?? PROTOCOL).replace('{slot}', () => request.input.systemPrompt ?? ''); }
export function codexBaseInstructions(request: Pick<AdapterRequest, 'input'>): string { return `${participantInstructions(request)}\n\n${CODEX_DEVELOPER_INSTRUCTIONS}`; }
export function localTimestamp(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  return new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
export function buildPrompts(request: Pick<AdapterRequest, 'input' | 'history'>): { system: string; user: string } {
  const { input, history } = request;
  return {
    system: participantInstructions(request),
    user: JSON.stringify({ participantName: input.participantName, privateMemo: input.privateMemo,
      currentThread: input.currentThread.messages.map((message) => `[${message.res}] ${localTimestamp((message as { createdAt?: number }).createdAt)} ${message.author}\n${message.content}`).join('\n\n'),
      metadata: { thread: input.currentThread.number, latest: input.currentThread.latestResNumber, newlyObservedAfter: input.currentThread.newlyObservedAfter, rollover: input.currentThread.isRolloverSinceObserved },
      postReferences: input.currentThread.postReferences, requestedReads: history }),
  };
}
export function reasoningValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
export function vertexRequest(request: AdapterRequest, outputTokens: number) {
  const { system, user } = buildPrompts(request); const thinkingLevel = reasoningValue(request.participant.modelOptions.thinkingLevel);
  return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: ACTION_SCHEMA, maxOutputTokens: outputTokens, thinkingConfig: { includeThoughts: false, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) } } };
}
export function compatibleRequest(request: AdapterRequest, connection: Connection, outputTokens: number) {
  const { system, user } = buildPrompts(request);
  return { model: request.participant.modelId, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: outputTokens, stream: false,
    ...(connection.config.jsonMode !== false ? { response_format: { type: 'json_object' } } : {}) };
}
export function codexTurnInput(request: Pick<AdapterRequest, 'input' | 'history'>, firstTurn: boolean): string {
  return firstTurn ? buildPrompts(request).user : JSON.stringify({ requestedReads: request.history.slice(-1) });
}
export function corePrompts(template = PROTOCOL) {
  return [{ name: '공통 Action Protocol · Room 규칙', adapter: 'all', text: template },
    { name: 'Vertex 응답 형식 제약', adapter: 'vertex', text: JSON.stringify(ACTION_SCHEMA, null, 2) },
    { name: 'Codex Adapter 추가 고정 지침', adapter: 'codex', text: CODEX_DEVELOPER_INSTRUCTIONS },
    { name: '호환 API JSON 응답 형식 제약 (JSON mode 사용 시)', adapter: 'oai-compatible', text: JSON.stringify({ response_format: { type: 'json_object' } }, null, 2) },
    { name: 'Custom API JSON 응답 형식 제약 (JSON mode 사용 시)', adapter: 'custom-api', text: JSON.stringify({ response_format: { type: 'json_object' } }, null, 2) }];
}
export function previewRequest(request: AdapterRequest, connection: Connection | null) {
  const prompts = buildPrompts(request); const type = connection?.type ?? 'none'; const outputTokens = Number(request.participant.modelOptions.outputTokens ?? 4096);
  const transport = type === 'vertex' ? vertexRequest(request, outputTokens) : ['oai-compatible', 'custom-api'].includes(type) && connection ? compatibleRequest(request, connection, outputTokens)
    : type === 'codex' ? { thread: { model: request.participant.modelId, baseInstructions: codexBaseInstructions(request) }, turn: { input: [{ type: 'text', text: codexTurnInput(request, true) }], ...(reasoningValue(request.participant.modelOptions.reasoningEffort) === undefined ? {} : { effort: reasoningValue(request.participant.modelOptions.reasoningEffort) }) } } : prompts;
  return { adapter: type, fixedInstructions: corePrompts(request.input.corePrompt ?? PROTOCOL).filter((prompt) => prompt.adapter === 'all' || prompt.adapter === type), participantPrompt: request.input.systemPrompt, system: type === 'codex' ? codexBaseInstructions(request) : prompts.system, user: prompts.user,
    transport, note: type === 'codex' ? CODEX_PREVIEW_NOTE : null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
