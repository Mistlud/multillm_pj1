export type Id = string;
export type AuthorType = "admin" | "participant";
export type ThreadStatus = "open" | "closed";
export type CycleStatus = "calling" | "completed" | "failed" | "abandoned" | "input_blocked";
export type RuntimeStatus = "idle" | "calling" | "error" | "input_blocked" | "off";

export interface CoreLimits {
  messageTokens: number;
  privateMemoTokens: number;
  postTokens: number;
  inputTokens: number;
  outputReserveTokens: number;
  toolReturnTokens: number;
  retryBackoffMs: number;
  maxToolRounds: number;
  cycleTimeoutMs: number;
  minPollMs: number;
  maxPollMs: number;
}

export interface Room {
  id: Id;
  name: string;
  currentThreadId: Id;
  createdAt: number;
}

export interface Thread {
  id: Id;
  roomId: Id;
  number: number;
  status: ThreadStatus;
  resCount: number;
  createdAt: number;
  closedAt: number | null;
  deletedAt: number | null;
}

export interface PublicRes {
  id: number;
  threadId: Id;
  threadNumber: number;
  number: number;
  author: { type: AuthorType; id: Id | null; displayName: string };
  body: string;
  postId: number | null;
  generatedFrom: Cursor | null;
  createdAt: number;
}

export interface Post {
  id: number;
  roomId: Id;
  author: { type: AuthorType; id: Id | null; displayName: string };
  title: string;
  body: string;
  createdAt: number;
  deletedAt: number | null;
}

export interface Cursor {
  threadId: Id;
  resNumber: number;
}

export interface Connection {
  id: Id;
  name: string;
  type: string;
  config: Record<string, unknown>;
  credentialRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Participant {
  id: Id;
  roomId: Id;
  displayName: string;
  avatar: string | null;
  enabled: boolean;
  connectionId: Id | null;
  modelId: string;
  modelOptions: Record<string, unknown>;
  systemPrompt: string;
  privateMemo: string;
  createdAt: number;
  updatedAt: number;
}

export interface ParticipantMemo {
  participantId: Id;
  displayName: string;
  privateMemo: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ParticipantRuntime {
  participantId: Id;
  observed: Cursor | null;
  lastPosted: Cursor | null;
  nextPollAt: number | null;
  status: RuntimeStatus;
  activeCycleId: Id | null;
  lastError: string | null;
  blockedAt: Cursor | null;
  blockedInputSignature: string | null;
  permanentError: boolean;
}

export interface ParticipantDetail extends Participant {
  runtime: ParticipantRuntime;
}

export interface UsageRecord {
  id: number;
  participantId: Id;
  connectionId: Id | null;
  cycleId: Id;
  requestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens?: number | null;
  participantName?: string | null;
  connectionName?: string | null;
  connectionType?: string | null;
  participantDeleted: boolean;
  connectionDeleted: boolean;
  simulated?: boolean;
  providerUsage: Record<string, unknown> | null;
  createdAt: number;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}
export interface UsageAggregate { id: Id; displayName: string | null; type?: string | null; calls: number; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null; simulated: boolean; deleted: boolean; }
export interface UsageDetails { participants: UsageAggregate[]; connections: UsageAggregate[]; }
export type DashboardPeriod = "today" | "7d" | "30d";
export type DashboardMode = "real" | "mock";
export interface DashboardCycleCounts { calling: number; completed: number; failed: number; abandoned: number; input_blocked: number; }
export interface DashboardTokenAggregate { calls: number; inputTokens: number | null; outputTokens: number | null; inputKnownCalls: number; outputKnownCalls: number; }
export interface DashboardParticipant extends DashboardTokenAggregate { id: Id; displayName: string | null; deleted: boolean; cycles: DashboardCycleCounts; }
export interface DashboardBucket extends DashboardTokenAggregate { start: number; end: number; label: string; }
export interface DashboardChoice { id: Id; displayName: string | null; type?: string | null; deleted: boolean; }
export interface DashboardData {
  range: { from: number; to: number; timeZone: string; bucket: "hour" | "day" };
  filters: { period: DashboardPeriod; mode: DashboardMode; participantId: Id | null; connectionId: Id | null };
  totals: DashboardTokenAggregate & { cycles: DashboardCycleCounts; unclassifiedCycles: number };
  buckets: DashboardBucket[];
  participants: DashboardParticipant[];
  choices: { participants: DashboardChoice[]; connections: DashboardChoice[] };
}
export interface NotificationCursor { generation: string; lastResId: number; }
export interface NotificationItem { id: number; kind: 'res' | 'post'; authorName: string; }
export interface RoomNotifications { cursor: NotificationCursor; items: NotificationItem[]; truncated: boolean; }
export interface CycleEvent { id: number; cycleId: Id; kind: 'started' | 'read' | 'final' | 'completed' | 'failed'; payload: Record<string, unknown> | null; createdAt: number; }
export interface CycleConnection { id: Id; displayName: string | null; type: string | null; deleted: boolean; }
export interface CycleDetail { cycle: Cycle; events: CycleEvent[]; usage: UsageRecord[]; result: { resId: number | null; postId: number | null } | null; connection: CycleConnection | null; }
export interface ErrorRecord { id: number; roomId: Id; source: string; participantId: Id | null; connectionId: Id | null; cycleId: Id | null; httpStatus: number | null; providerCode: string | null; message: string; details: unknown; createdAt: number; }

export interface CycleSnapshot {
  threadId: Id;
  threadNumber: number;
  latestResNumber: number;
  maxPostId: number;
  observedBefore: Cursor | null;
}

export interface Cycle {
  id: Id;
  participantId: Id;
  roomId: Id;
  serverRunId: Id;
  snapshot: CycleSnapshot;
  inputSignature: string;
  status: CycleStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  participantDeleted?: boolean;
  participantName?: string | null;
}

export interface AddConnectionInput {
  id?: Id;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  credentialRef?: string | null;
}

export interface UpdateConnectionInput {
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
  credentialRef?: string | null;
}

export interface AddParticipantInput {
  id?: Id;
  roomId: Id;
  displayName: string;
  avatar?: string | null;
  enabled?: boolean;
  connectionId?: Id | null;
  modelId: string;
  modelOptions?: Record<string, unknown>;
  systemPrompt?: string;
  privateMemo?: string;
}

export interface UpdateParticipantInput {
  displayName?: string;
  avatar?: string | null;
  enabled?: boolean;
  connectionId?: Id | null;
  modelId?: string;
  modelOptions?: Record<string, unknown>;
  systemPrompt?: string;
  privateMemo?: string;
}

export interface AppendResInput {
  roomId: Id;
  author: PublicRes["author"];
  body: string;
  generatedFrom?: Cursor | null;
}

export type ParticipantAction =
  | { action: "wait"; memo?: string | null }
  | { action: "reply"; message: string; memo?: string | null }
  | { action: "post"; title: string; body: string; message: string; memo?: string | null }
  | { action: "read_archive"; query: string }
  | { action: "read_res"; thread: number; res: number }
  | { action: "read_range"; thread: number; from: number; to: number }
  | { action: "read_post"; postId: number };

export type FinalAction = Extract<ParticipantAction, { action: "wait" | "reply" | "post" }>;
export type ReadAction = Exclude<ParticipantAction, FinalAction>;

export interface ActionResult {
  action: unknown;
  usage?: AdapterUsage;
}

export interface AdapterUsage {
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number | null;
  raw?: Record<string, unknown>;
}

export interface ModelInput {
  participantName: string;
  systemPrompt: string;
  /** Common prompt captured when the cycle/preview starts. */
  corePrompt?: string;
  privateMemo: string;
  currentThread: {
    id: Id;
    number: number;
    latestResNumber: number;
    isRolloverSinceObserved: boolean;
    newlyObservedAfter: number;
    messages: Array<{ thread: number; res: number; author: string; content: string; createdAt: number }>;
    postReferences: Array<{ id: number; title: string; author: string }>;
  };
}

export interface ToolResult {
  action: ReadAction;
  content: unknown;
}

export interface AdapterParticipant {
  id: Id;
  connectionId: Id | null;
  modelId: string;
  modelOptions: Record<string, unknown>;
}

export interface AdapterRequest {
  participant: AdapterParticipant;
  input: ModelInput;
  history: ToolResult[];
  signal: AbortSignal;
}

export interface ParticipantAdapter {
  /** Absent adapters use the conservative core cl100k_base budget; they are never unlimited. */
  inputBudget?: {
    maxInputTokens: number;
    outputReserveTokens: number;
    countInputTokens?: (request: Pick<AdapterRequest, "input" | "history">) => number;
  };
  run(request: AdapterRequest): Promise<ActionResult>;
  dispose?(): Promise<void> | void;
}

/** Adapter implementations may expose retry policy without leaking provider errors into the Room. */
export class AdapterError extends Error {
  readonly retryAfterMs: number | null;
  readonly permanent: boolean;
  readonly usage: AdapterUsage | undefined;
  readonly inputBlocked: boolean;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;
  readonly details: unknown;
  constructor(message: string, options: { retryAfterMs?: number | null; permanent?: boolean; usage?: AdapterUsage; inputBlocked?: boolean; httpStatus?: number | null; providerCode?: string | null; details?: unknown } = {}) {
    super(message);
    this.name = "AdapterError";
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.permanent = options.permanent ?? false;
    this.usage = options.usage;
    this.inputBlocked = options.inputBlocked ?? false;
    this.httpStatus = options.httpStatus ?? null;
    this.providerCode = options.providerCode ?? null;
    this.details = options.details;
  }
}

export type AdapterResolver = (participant: Participant, connection: Connection | null) => ParticipantAdapter | undefined;

export interface WorkerManagerOptions {
  serverRunId?: Id;
  adapters: AdapterResolver;
  limits?: Partial<CoreLimits>;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
