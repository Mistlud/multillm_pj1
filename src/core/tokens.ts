import { getEncoding, type Tiktoken } from "js-tiktoken";

export type TokenCounter = (text: string) => number;

let encoder: Tiktoken | undefined;

/** Uses the project's shared cl100k_base policy for every persisted text limit. */
export const countTokens: TokenCounter = (text) => {
  encoder ??= getEncoding("cl100k_base");
  return encoder.encode(text).length;
};

export function assertTokenLimit(text: string, limit: number, label: string, counter: TokenCounter): void {
  const tokens = counter(text);
  if (tokens > limit) {
    throw new Error(`${label} exceeds the ${limit}-token limit (${tokens} tokens)`);
  }
}
