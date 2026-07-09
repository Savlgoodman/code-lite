import type { BillingModelPrice, BillingPricesResult, ChatMessage } from "../../types";

export interface ModelUsage {
  billingMultiplier: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  displayRate?: string;
  fastModeEnabled: boolean;
  inputTokens: number;
  modelCandidates: string[];
  modelId: string;
  modelLabel: string;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  turnCount: number;
  usageKey: string;
}

export interface ModelCost {
  baseTotalCostUsd: number;
  billingMultiplier: number;
  cachedReadCostUsd: number;
  cachedWriteCostUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  price?: BillingModelPrice;
  priceModelId?: string;
  thoughtCostUsd: number;
  totalCostUsd: number;
}

export interface ModelUsageWithCost extends ModelUsage {
  cost: ModelCost | null;
}

export interface SessionBillingSummary {
  grandTotal: {
    cachedRead: number;
    cachedWrite: number;
    input: number;
    output: number;
    thought: number;
    total: number;
  };
  hasBreakdown: boolean;
  modelUsages: ModelUsageWithCost[];
  pricedModelCount: number;
  totalCostUsd: number;
  unknownCostModelCount: number;
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.000000";
  }
  if (value < 0.000001) {
    return "<$0.000001";
  }
  if (value < 0.01) {
    return `$${value.toFixed(6)}`;
  }
  return `$${value.toFixed(4)}`;
}

export function modelValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function buildSessionBillingSummary(
  messages: ChatMessage[],
  prices: BillingPricesResult | null,
): SessionBillingSummary {
  const modelUsages = buildModelUsage(messages).map((usage) => ({
    ...usage,
    cost: calculateModelCost(usage, prices),
  }));
  const hasBreakdown = modelUsages.some(
    (usage) =>
      usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cachedReadTokens > 0 ||
      usage.cachedWriteTokens > 0 ||
      usage.thoughtTokens > 0,
  );
  const grandTotal = modelUsages.reduce(
    (acc, usage) => ({
      input: acc.input + usage.inputTokens,
      output: acc.output + usage.outputTokens,
      cachedRead: acc.cachedRead + usage.cachedReadTokens,
      cachedWrite: acc.cachedWrite + usage.cachedWriteTokens,
      thought: acc.thought + usage.thoughtTokens,
      total: acc.total + usage.totalTokens,
    }),
    { input: 0, output: 0, cachedRead: 0, cachedWrite: 0, thought: 0, total: 0 },
  );
  const totalCostUsd = modelUsages.reduce((sum, usage) => sum + (usage.cost?.totalCostUsd ?? 0), 0);
  const pricedModelCount = modelUsages.filter((usage) => usage.cost !== null).length;

  return {
    grandTotal,
    hasBreakdown,
    modelUsages,
    pricedModelCount,
    totalCostUsd,
    unknownCostModelCount: Math.max(0, modelUsages.length - pricedModelCount),
  };
}

function buildModelUsage(messages: ChatMessage[]): ModelUsage[] {
  const map = new Map<string, ModelUsage>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.usage) continue;

    const modelInfo = msg.model as Record<string, unknown> | undefined;
    const runtimeModel = modelValue(modelInfo?.runtimeModel);
    const model = modelValue(modelInfo?.model);
    const modelId = runtimeModel || model || "unknown";
    const baseModelLabel = modelValue(modelInfo?.label) || (modelId === "unknown" ? "未知模型" : modelId);
    const modelCandidates = buildModelCandidates([runtimeModel, model, baseModelLabel]);
    const fastMode = readFastModeCostState(modelInfo?.fastMode);
    const usageKey = `${modelId}::fast:${fastMode.billingMultiplier}:${fastMode.displayRate ?? ""}`;
    const modelLabel = baseModelLabel;

    if (!map.has(usageKey)) {
      map.set(usageKey, {
        billingMultiplier: fastMode.billingMultiplier,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        displayRate: fastMode.displayRate,
        fastModeEnabled: fastMode.enabled,
        inputTokens: 0,
        modelCandidates,
        modelId,
        modelLabel,
        outputTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
        turnCount: 0,
        usageKey,
      });
    }

    const usage = msg.usage;
    const modelUsage = map.get(usageKey)!;
    modelUsage.inputTokens += tokenValue(usage.inputTokens) || tokenValue(usage.promptTokens);
    modelUsage.outputTokens += tokenValue(usage.outputTokens) || tokenValue(usage.completionTokens);
    modelUsage.cachedReadTokens += tokenValue(usage.cachedReadTokens);
    modelUsage.cachedWriteTokens += tokenValue(usage.cachedWriteTokens);
    modelUsage.thoughtTokens += tokenValue(usage.thoughtTokens);
    modelUsage.totalTokens += tokenValue(usage.totalTokens);
    modelUsage.turnCount += 1;
    modelUsage.modelCandidates = buildModelCandidates([...modelUsage.modelCandidates, ...modelCandidates]);
  }

  return Array.from(map.values());
}

function calculateModelCost(usage: ModelUsage, prices: BillingPricesResult | null): ModelCost | null {
  const match = findPrice(usage.modelCandidates, prices);
  if (!match) {
    return null;
  }

  const price = match.price;
  const inputCostUsd = usage.inputTokens * (price.inputCostPerToken ?? 0);
  const outputCostUsd = usage.outputTokens * (price.outputCostPerToken ?? 0);
  const thoughtCostUsd = usage.thoughtTokens * (price.outputCostPerToken ?? 0);
  const cachedReadCostUsd = usage.cachedReadTokens * (price.cachedReadCostPerToken ?? price.inputCostPerToken ?? 0);
  const cachedWriteCostUsd = usage.cachedWriteTokens * (price.cachedWriteCostPerToken ?? price.inputCostPerToken ?? 0);
  const baseTotalCostUsd = inputCostUsd + outputCostUsd + thoughtCostUsd + cachedReadCostUsd + cachedWriteCostUsd;
  const billingMultiplier = usage.billingMultiplier > 0 ? usage.billingMultiplier : 1;

  return {
    baseTotalCostUsd,
    billingMultiplier,
    cachedReadCostUsd,
    cachedWriteCostUsd,
    inputCostUsd,
    outputCostUsd,
    price,
    priceModelId: match.modelId,
    thoughtCostUsd,
    totalCostUsd: baseTotalCostUsd * billingMultiplier,
  };
}

function findPrice(
  candidates: string[],
  prices: BillingPricesResult | null,
): { modelId: string; price: BillingModelPrice } | null {
  if (!prices?.models) {
    return null;
  }

  const directCandidates = buildModelCandidates(candidates);
  for (const candidate of directCandidates) {
    const exact = prices.models[candidate];
    if (exact) {
      return { modelId: candidate, price: exact };
    }
  }

  const priceEntries = Object.entries(prices.models);
  const normalizedCandidates = new Set(directCandidates.map(normalizeModelKey));
  for (const [modelId, price] of priceEntries) {
    if (normalizedCandidates.has(normalizeModelKey(modelId))) {
      return { modelId, price };
    }
  }

  return null;
}

function buildModelCandidates(values: string[]): string[] {
  const candidates: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "unknown") {
      continue;
    }
    candidates.push(trimmed);
    candidates.push(trimmed.replace(/^\w+\//, ""));
    candidates.push(trimmed.replace(/\[[^\]]+\]$/, ""));
    candidates.push(trimmed.replace(/^\w+\//, "").replace(/\[[^\]]+\]$/, ""));
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function normalizeModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\w+\//, "")
    .replace(/\[[^\]]+\]$/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readFastModeCostState(value: unknown): { billingMultiplier: number; displayRate?: string; enabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { billingMultiplier: 1, enabled: false };
  }
  const fastMode = value as Record<string, unknown>;
  const enabled = fastMode.enabled === true && fastMode.applied !== false;
  const rawMultiplier = fastMode.billingMultiplier;
  const multiplier = typeof rawMultiplier === "number" && Number.isFinite(rawMultiplier) && rawMultiplier > 0
    ? rawMultiplier
    : enabled ? 2 : 1;
  const displayRate = typeof fastMode.displayRate === "string" && fastMode.displayRate.trim()
    ? fastMode.displayRate.trim()
    : enabled ? "1.5x" : undefined;
  return { billingMultiplier: multiplier, displayRate, enabled };
}
