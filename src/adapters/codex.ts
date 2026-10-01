import type { AdapterRequest, ActionResult, Connection, ParticipantAdapter } from '../core/index.js';
import { AdapterError, buildPrompts } from './index.js';
import type { CodexCycle, CodexManagerLike } from '../server/codex.js';

function textUsage(value: Record<string, unknown> | undefined) {
  if (!value) return undefined;
  const last = value.last && typeof value.last === 'object' ? value.last as Record<string, unknown> : value;
  const token = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  return { requestId: typeof value.requestId === 'string' ? value.requestId : undefined, inputTokens: token(last.inputTokens ?? last.input_tokens), outputTokens: token(last.outputTokens ?? last.output_tokens), cachedInputTokens: token(last.cachedInputTokens ?? last.cached_tokens), raw: value };
}
function parseAction(text: string, usage: ReturnType<typeof textUsage>): unknown {
  const value = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch { throw new AdapterError('Codex가 유효한 JSON action을 반환하지 않았습니다.', false, undefined, usage); }
}

/** One app-server process/thread is dedicated to a claimed cycle and never inherits a personal Codex session. */
export class CodexAdapter implements ParticipantAdapter {
  readonly inputBudget;
  private cycle?: CodexCycle;
  private firstTurn = true;
  private disposed = false;
  constructor(private readonly connection: Connection, private readonly manager: CodexManagerLike) {
    const context = Number(connection.config.contextTokens ?? 64_000);
    this.inputBudget = { maxInputTokens: Number.isInteger(context) ? context : 0, outputReserveTokens: 4096, countInputTokens: (request: Pick<AdapterRequest, 'input' | 'history'>) => { const prompts = buildPrompts(request); return Buffer.byteLength(prompts.system + prompts.user, 'utf8'); } };
  }
  async run(request: AdapterRequest): Promise<ActionResult> {
    if (request.signal.aborted || this.disposed) throw new AdapterError('Codex 요청이 중단되었습니다.');
    const effort = String(request.participant.modelOptions.reasoningEffort ?? 'medium');
    if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw new AdapterError('Codex reasoningEffort 설정을 확인하세요.', true);
    const abort = () => { void this.dispose(); };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      if (!this.cycle) {
        const prompts = buildPrompts(request);
        const cycle = await this.manager.openCycle(this.connection, prompts.system, request.participant.modelId, request.signal);
        if (this.disposed || request.signal.aborted) { await cycle.dispose(); throw new AdapterError('Codex 요청이 중단되었습니다.'); }
        this.cycle = cycle;
      }
      const input = this.firstTurn ? buildPrompts(request).user : JSON.stringify({ requestedReads: request.history.slice(-1) });
      this.firstTurn = false;
      const result = await this.cycle.turn(input, effort);
      const usage = textUsage(result.usage);
      return { action: parseAction(result.text, usage), usage };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(error instanceof Error ? error.message : 'Codex 요청에 실패했습니다.');
    } finally { request.signal.removeEventListener('abort', abort); }
  }
  async dispose(): Promise<void> { this.disposed = true; const cycle = this.cycle; this.cycle = undefined; await cycle?.dispose(); }
}
