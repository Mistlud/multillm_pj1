import { randomUUID } from "node:crypto";
import { validateAction } from "./actions.js";
import { RoomStore, type ClaimedCycle } from "./room-store.js";
import { countTokens } from "./tokens.js";
import { AdapterError, type ParticipantAdapter, type ReadAction, type ToolResult, type WorkerManagerOptions } from "./types.js";

class CycleTimeoutError extends Error { constructor() { super("cycle timed out"); } }

/** Coordinates independent participant polling without deciding whether they should speak. */
export class WorkerManager {
  readonly serverRunId: string;
  private readonly store: RoomStore;
  private readonly options: Required<Pick<WorkerManagerOptions, "adapters" | "now" | "random" | "setTimer" | "clearTimer">>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly retryDelays = new Map<string, number | null>();
  private started = false;
  private stopped = false;

  constructor(store: RoomStore, options: WorkerManagerOptions) {
    this.store = store;
    this.serverRunId = options.serverRunId ?? randomUUID();
    this.options = {
      adapters: options.adapters,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      setTimer: options.setTimer ?? ((callback, delay) => setTimeout(callback, delay)),
      clearTimer: options.clearTimer ?? ((timer) => clearTimeout(timer)),
    };
  }

  /** Recovery happens before any new schedule, so a prior process can never commit late output. */
  start(): void {
    if (this.started || this.stopped) return;
    this.store.abandonStaleCycles();
    this.started = true;
    for (const participant of this.store.listParticipantsForScheduling()) if (participant.enabled) this.schedule(participant.id);
  }

  /** Server OFF aborts requests where possible and invalidates all active database claims immediately. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.started = false;
    for (const timer of this.timers.values()) this.options.clearTimer(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.store.invalidateRun(this.serverRunId);
  }

  setEnabled(participantId: string, enabled: boolean): void {
    this.store.updateParticipant(participantId, { enabled });
    this.clearSchedule(participantId);
    if (enabled && this.started && !this.stopped) this.schedule(participantId);
  }

  schedule(participantId: string, delayOverride?: number | null): void {
    if (!this.started || this.stopped) return;
    const participant = this.store.getParticipant(participantId);
    if (!participant?.enabled || participant.runtime.activeCycleId || participant.runtime.permanentError) return;
    this.clearSchedule(participantId);
    if (delayOverride === null) { this.store.setNextPoll(participantId, null); return; }
    const delay = delayOverride ?? this.nextDelay();
    this.store.setNextPoll(participantId, this.options.now() + delay);
    const timer = this.options.setTimer(() => {
      this.timers.delete(participantId);
      void this.pollNow(participantId);
    }, delay);
    this.timers.set(participantId, timer);
  }

  async pollNow(participantId: string): Promise<void> {
    if (this.stopped) return;
    this.clearSchedule(participantId);
    const claimed = this.store.claimCycle({ participantId, serverRunId: this.serverRunId });
    if (!claimed) { this.schedule(participantId); return; }
    try {
      await this.runCycle(claimed);
    } finally {
      const retryDelay = this.retryDelays.get(participantId);
      this.retryDelays.delete(participantId);
      if (!this.stopped) this.schedule(participantId, retryDelay);
    }
  }

  private async runCycle(claimed: ClaimedCycle): Promise<void> {
    try {
      const adapter = this.options.adapters(claimed.participant, claimed.connection);
      if (!adapter) {
        this.store.failCycle({ cycleId: claimed.cycle.id, serverRunId: this.serverRunId, permanent: true, error: "no adapter is available for this participant" });
        this.retryDelays.set(claimed.participant.id, null);
        return;
      }
      if (this.exceedsInputLimit(adapter, claimed.input, [])) {
        this.store.failCycle({ cycleId: claimed.cycle.id, serverRunId: this.serverRunId, status: "input_blocked", error: "model input plus output reserve exceeds configured limit" });
        return;
      }
      const controller = new AbortController(); this.controllers.set(claimed.cycle.id, controller);
      const history: ToolResult[] = [];
      const deadline = claimed.cycle.startedAt + this.store.limits.cycleTimeoutMs;
      for (let round = 0; round <= this.store.limits.maxToolRounds; round += 1) {
        const result = await this.request(adapter, claimed, history, controller, deadline);
        const action = validateAction(result.action);
        if (action.action === "wait" || action.action === "reply" || action.action === "post") {
          this.store.completeCycle({ cycleId: claimed.cycle.id, serverRunId: this.serverRunId, action });
          return;
        }
        if (round === this.store.limits.maxToolRounds) throw new Error("tool round limit exceeded");
        const toolResult = this.executeRead(claimed, action);
        if (countTokens(JSON.stringify(toolResult.content)) > this.store.limits.toolReturnTokens) throw new Error("tool result exceeds configured return limit");
        history.push(toolResult);
        if (this.exceedsInputLimit(adapter, claimed.input, history)) {
          this.store.failCycle({ cycleId: claimed.cycle.id, serverRunId: this.serverRunId, status: "input_blocked", error: "model input plus output reserve exceeds configured limit after read action" });
          return;
        }
      }
    } catch (error) {
      if (!this.stopped) {
        const adapterError = error instanceof AdapterError ? error : null;
        const inputBlocked = adapterError?.inputBlocked ?? false;
        this.store.failCycle({ cycleId: claimed.cycle.id, serverRunId: this.serverRunId, status: inputBlocked ? "input_blocked" : "failed", permanent: adapterError?.permanent ?? false, error: error instanceof Error ? error.message : String(error) });
        if (!inputBlocked) this.retryDelays.set(claimed.participant.id, this.store.getParticipant(claimed.participant.id)?.runtime.permanentError ? null : Math.max(adapterError?.retryAfterMs ?? 0, this.store.limits.retryBackoffMs));
      }
    } finally {
      this.controllers.delete(claimed.cycle.id);
    }
  }

  private async request(adapter: ParticipantAdapter, claimed: ClaimedCycle, history: ToolResult[], controller: AbortController, deadline: number) {
    const usageRecord = this.store.recordUsage({ participantId: claimed.participant.id, connectionId: claimed.participant.connectionId, cycleId: claimed.cycle.id });
    const record = (usage: { requestId?: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; raw?: Record<string, unknown> } | undefined): void => {
      if (!usage) return;
      try { this.store.updateUsage(usageRecord.id, { requestId: usage.requestId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, providerUsage: usage.raw }); } catch { /* Store may already be closed after shutdown. */ }
    };
    const request = adapter.run({ participant: { id: claimed.participant.id, connectionId: claimed.participant.connectionId, modelId: claimed.participant.modelId, modelOptions: claimed.participant.modelOptions }, input: claimed.input, history, signal: controller.signal });
    // A provider can ignore AbortSignal. Its eventual measured usage still belongs to the abandoned cycle.
    void request.then((result) => record(result.usage), () => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const remaining = deadline - this.options.now();
    if (remaining <= 0) { controller.abort(); throw new CycleTimeoutError(); }
    try {
      const result = await Promise.race([
        request,
        new Promise<never>((_, reject) => { timeout = this.options.setTimer(() => { controller.abort(); reject(new CycleTimeoutError()); }, remaining); }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new CycleTimeoutError()), { once: true })),
      ]);
      record(result.usage);
      return result;
    } catch (error) {
      if (error instanceof AdapterError) record(error.usage);
      throw error;
    } finally {
      if (timeout) this.options.clearTimer(timeout);
    }
  }

  private executeRead(claimed: ClaimedCycle, action: ReadAction): ToolResult {
    const roomId = claimed.participant.roomId;
    switch (action.action) {
      case "read_archive":
        return { action, content: this.store.searchArchive(roomId, action.query, 20).filter((message) => message.threadNumber < claimed.cycle.snapshot.threadNumber || (message.threadId === claimed.cycle.snapshot.threadId && message.number <= claimed.cycle.snapshot.latestResNumber)).map(publicMessage) };
      case "read_res": {
        if (action.thread > claimed.cycle.snapshot.threadNumber) return { action, content: null };
        if (action.thread === claimed.cycle.snapshot.threadNumber && action.res > claimed.cycle.snapshot.latestResNumber) return { action, content: null };
        const message = this.store.readRes(roomId, action.thread, action.res);
        return { action, content: message ? publicMessage(message) : null };
      }
      case "read_range": {
        if (action.thread > claimed.cycle.snapshot.threadNumber) return { action, content: [] };
        const to = action.thread === claimed.cycle.snapshot.threadNumber ? Math.min(action.to, claimed.cycle.snapshot.latestResNumber) : action.to;
        return { action, content: this.store.readRange(roomId, action.thread, action.from, to, 100).map(publicMessage) };
      }
      case "read_post": {
        if (action.postId > claimed.cycle.snapshot.maxPostId) return { action, content: null };
        const post = this.store.readPost(roomId, action.postId);
        return { action, content: post ? { id: post.id, title: post.title, author: post.author.displayName, body: post.body } : null };
      }
    }
  }

  private exceedsInputLimit(adapter: ParticipantAdapter, input: ClaimedCycle["input"], history: ToolResult[]): boolean {
    const budget = adapter.inputBudget;
    const tokens = budget?.countInputTokens?.({ input, history }) ?? countTokens(JSON.stringify({ input, history }));
    const maximum = budget?.maxInputTokens ?? this.store.limits.inputTokens;
    const reserve = budget?.outputReserveTokens ?? this.store.limits.outputReserveTokens;
    return !Number.isFinite(tokens) || tokens + reserve > maximum;
  }
  private nextDelay(): number { return Math.floor(this.store.limits.minPollMs + this.options.random() * (this.store.limits.maxPollMs - this.store.limits.minPollMs)); }
  private clearSchedule(participantId: string): void { const timer = this.timers.get(participantId); if (timer) this.options.clearTimer(timer); this.timers.delete(participantId); }
}

function publicMessage(message: { threadNumber: number; number: number; author: { displayName: string }; body: string }) {
  return { thread: message.threadNumber, res: message.number, author: message.author.displayName, content: message.body };
}
