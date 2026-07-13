import { useLayoutEffect, type RefObject } from "react";
import { isNativeApp } from "../lib/environment";

/**
 * useNativeRepaint — 依赖变化时请求安卓 WebView 重绘目标元素。
 *
 * 软键盘弹起且输入框保持焦点时，部分安卓 WebView 会保留按钮先前的 :disabled 绘制结果。
 * 此时 disabled 属性已经解除，按钮能够点击，但背景要等到键盘收起触发布局后才更新。
 *
 * 显式 is-enabled / is-disabled class 是主修复；这里仅在原生 App 对目标按钮做一帧透明度
 * 脉冲，促使 WebView 重新绘制。目标应尽量小，避免对整个输入区创建合成层。
 *
 * 仅原生 App 生效；桌面 / PWA 浏览器直接跳过。
 */
export function useNativeRepaint<T extends HTMLElement>(ref: RefObject<T | null>, dep: unknown) {
  useLayoutEffect(() => {
    if (!isNativeApp()) return;
    const el = ref.current;
    if (!el) return;
    const prev = el.style.opacity;
    el.style.opacity = "0.999";
    const restore = () => {
      if (el.style.opacity === "0.999") el.style.opacity = prev;
    };
    const raf = requestAnimationFrame(() => {
      restore();
    });
    return () => {
      cancelAnimationFrame(raf);
      restore();
    };
  }, [ref, dep]);
}
