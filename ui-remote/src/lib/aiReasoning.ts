export const AI_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export function normalizeAiReasoningEffort(value: unknown): AiReasoningEffort | null {
  return AI_REASONING_EFFORTS.find((effort) => effort === value) ?? null;
}
