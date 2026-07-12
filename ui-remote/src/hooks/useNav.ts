/**
 * useNav — 订阅导航栈快照并暴露导航动词。
 *
 * 组件用 `const nav = useNav()` 拿到当前栈与 push/pop/replace/reset；
 * 只想读栈顶或深度的场景可用 `useNav().top` / `.depth`。
 * 导航动词是稳定引用（直接来自 navStore 单例），可安全放进依赖数组。
 */

import { useSyncExternalStore } from "react";
import { navStore, type ScreenEntry, type StackItem } from "../services/navStore";

export interface NavApi {
  /** 当前页面栈（从底到顶），每项含稳定 key 与 entry。 */
  stack: StackItem[];
  /** 栈顶页面参数；空栈（Tab 根）时为 undefined。 */
  top: ScreenEntry | undefined;
  /** 栈深度，0 表示 Tab 根。 */
  depth: number;
  push: (entry: ScreenEntry) => void;
  pop: () => boolean;
  replaceTop: (entry: ScreenEntry) => void;
  reset: () => void;
  /** 统一返回（先关瞬态层再弹栈）。 */
  back: () => boolean;
}

export function useNav(): NavApi {
  const stack = useSyncExternalStore(navStore.subscribe, navStore.getSnapshot);
  return {
    stack,
    top: stack[stack.length - 1]?.entry,
    depth: stack.length,
    push: (entry) => navStore.push(entry),
    pop: () => navStore.pop(),
    replaceTop: (entry) => navStore.replaceTop(entry),
    reset: () => navStore.reset(),
    back: () => navStore.back(),
  };
}
