import type { ParticipantAction } from "./types.js";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("action must be an object");
  return value as Record<string, unknown>;
}

function keysOnly(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown action field: ${key}`);
}

function string(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${field} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  return value;
}

function optionalMemo(value: Record<string, unknown>): string | null | undefined {
  if (!("memo" in value)) return undefined;
  if (value.memo !== null && typeof value.memo !== "string") throw new Error("memo must be a string or null");
  return value.memo as string | null;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

/** Converts untrusted native/fallback adapter output into the one internal protocol. */
export function validateAction(value: unknown): ParticipantAction {
  const action = object(value);
  const name = string(action.action, "action");
  switch (name) {
    case "wait": {
      keysOnly(action, ["action", "memo"]);
      const memo = optionalMemo(action);
      return memo === undefined ? { action: "wait" } : { action: "wait", memo };
    }
    case "reply": {
      keysOnly(action, ["action", "message", "memo"]);
      const memo = optionalMemo(action);
      return memo === undefined
        ? { action: "reply", message: string(action.message, "message") }
        : { action: "reply", message: string(action.message, "message"), memo };
    }
    case "post": {
      keysOnly(action, ["action", "title", "body", "message", "memo"]);
      const memo = optionalMemo(action);
      const base = { action: "post" as const, title: string(action.title, "title"), body: string(action.body, "body"), message: string(action.message, "message") };
      return memo === undefined ? base : { ...base, memo };
    }
    case "read_archive":
      keysOnly(action, ["action", "query"]);
      return { action: "read_archive", query: string(action.query, "query") };
    case "read_res":
      keysOnly(action, ["action", "thread", "res"]);
      return { action: "read_res", thread: positiveInteger(action.thread, "thread"), res: positiveInteger(action.res, "res") };
    case "read_range": {
      keysOnly(action, ["action", "thread", "from", "to"]);
      const from = positiveInteger(action.from, "from");
      const to = positiveInteger(action.to, "to");
      if (from > to) throw new Error("from must not exceed to");
      return { action: "read_range", thread: positiveInteger(action.thread, "thread"), from, to };
    }
    case "read_post":
      keysOnly(action, ["action", "postId"]);
      return { action: "read_post", postId: positiveInteger(action.postId, "postId") };
    default:
      throw new Error(`unsupported action: ${name}`);
  }
}
