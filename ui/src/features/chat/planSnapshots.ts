// Plan 合并逻辑已迁移到 packages/chat-core。
// 本文件保留为 re-export 桩，使现有相对引用零改动。
export { hasVisiblePlan, mergePlanSnapshot, latestMergedPlanFromMessages } from "@code-lite/chat-core";
