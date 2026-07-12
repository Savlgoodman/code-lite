/**
 * useDismissable — 让一个瞬态层（Sheet / 全屏预览等）参与系统返回。
 *
 * 当某个弹层打开时调用本 hook，把它的关闭动作注册到 navStore 的瞬态层栈；
 * 安卓返回键 / 浏览器 popstate 会优先关闭最上层已注册的瞬态层，而不是直接弹页面栈。
 *
 * 用法：
 *   useDismissable(open, () => setOpen(false));
 * 其中第二个参数应触发该层「带离场动画的关闭」，与点击遮罩/关闭按钮的行为一致。
 */

import { useEffect, useRef } from "react";
import { navStore, type DismissHandler } from "../services/navStore";

export function useDismissable(active: boolean, onDismiss: DismissHandler): void {
  // 用 ref 持有最新回调，避免因回调引用变化反复注册/注销。
  const handlerRef = useRef(onDismiss);
  handlerRef.current = onDismiss;

  useEffect(() => {
    if (!active) return;
    const unregister = navStore.registerDismissable(() => handlerRef.current());
    return unregister;
  }, [active]);
}
