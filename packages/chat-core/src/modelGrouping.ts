import type { SessionModel } from "@code-lite/protocol";

/**
 * 模型分组工具：把 ACP 返回的扁平 `family[effort]` 模型列表拆成二级结构。
 *
 * Codex 的 availableModels 形如 gpt-5.6-sol[low]/gpt-5.6-sol[max]/gpt-5.5[xhigh]，
 * 不同模型族支持的思考强度不同（5.6-Sol 有 ultra，5.4 只到 xhigh）。前端据此
 * 做「选模型族 → 动态展示该族支持的思考强度」的二级联动。
 *
 * Claude Code 等 runtime 的模型 id 不含 [effort]（如 sonnet/opus[1m]），此时
 * isGrouped=false，退化为直接选模型 id、不显示思考强度选择器。
 */

export interface ModelFamily {
  familyId: string; // 如 "gpt-5.6-sol"
  label: string; // 如 "GPT-5.6-Sol"
  description?: string | null;
  efforts: string[]; // 该族支持的思考强度，如 ["low","medium","high","xhigh","max","ultra"]
  isCurrent: boolean; // 该族中是否含 isCurrent 的条目
}

export interface ModelGrouping {
  families: ModelFamily[];
  currentFamilyId: string;
  currentEffort: string;
  /** true=含 [effort] 的二级结构；false=退化为单层（模型 id 即选择项）。 */
  isGrouped: boolean;
}

/** 拆分 modelId 为 {family, effort}。支持多段括号（取最后一段作为 effort）。 */
export function splitModelId(modelId: string): { family: string; effort: string | null } {
  const trimmed = (modelId ?? "").trim();
  if (!trimmed) return { family: "", effort: null };
  const match = trimmed.match(/^([^[]+)((?:\[[^\]]+\])+)?$/);
  if (!match) return { family: trimmed, effort: null };
  const efforts = [...(match[2] ?? "").matchAll(/\[([^\]]+)\]/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  return {
    family: match[1].trim(),
    effort: efforts.length > 0 ? efforts[efforts.length - 1] : null,
  };
}

/** 从模型族 + effort 组合回完整 modelId（effort 为空时只返回 family）。 */
export function buildModelId(familyId: string, effort: string | null | undefined): string {
  const fam = (familyId ?? "").trim();
  const eff = (effort ?? "").trim();
  return fam && eff ? `${fam}[${eff}]` : fam;
}

/** 从模型 label 推导族展示名：剥离结尾的 "(...)" 或 "[...]"。 */
function deriveFamilyLabel(model: SessionModel, familyId: string): string {
  const labelMatch = (model.label ?? "").match(/^(.*?)\s*(?:\(|\[)/);
  return labelMatch ? labelMatch[1].trim() : model.label || familyId;
}

/** 解析 SessionModel[] 为二级分组结构。 */
export function groupModelsByFamily(models: SessionModel[]): ModelGrouping {
  const familyMap = new Map<string, ModelFamily>();
  let anyEffort = false;
  let currentFamilyId = "";
  let currentEffort = "";

  for (const model of models) {
    const { family, effort } = splitModelId(model.id);
    if (effort) anyEffort = true;
    const key = family || model.id;
    if (!familyMap.has(key)) {
      familyMap.set(key, {
        familyId: key,
        label: deriveFamilyLabel(model, key),
        description: model.description,
        efforts: [],
        isCurrent: false,
      });
    }
    const fam = familyMap.get(key)!;
    if (effort && !fam.efforts.includes(effort)) {
      fam.efforts.push(effort);
    }
    if (model.isCurrent) {
      fam.isCurrent = true;
      currentFamilyId = key;
      currentEffort = effort ?? "";
    }
  }

  const families = Array.from(familyMap.values());

  // 无 isCurrent 时兜底选第一个族及其首个 effort。
  if (!currentFamilyId && families.length > 0) {
    currentFamilyId = families[0].familyId;
    currentEffort = families[0].efforts[0] ?? "";
  }

  return {
    families,
    currentFamilyId,
    currentEffort,
    isGrouped: anyEffort,
  };
}
