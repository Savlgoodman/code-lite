import { useRef, useLayoutEffect, type RefObject } from "react";
import { isNativeApp } from "../../lib/environment";

/**
 * useDefensiveTextValue — 受控/半受控文本输入的取值逻辑（input 与 textarea 共用）。
 *
 * 问题背景：安卓 WebView 的输入法（IME）与 React 受控输入（`value={value}`）天生冲突。
 * React 每次渲染都会把 `value` 强写回 `el.value`；在**中文/日文等 IME 组合期**，这次
 * 写入会打断/清空正在进行的候选词组合，表现为：
 *   1. 「刚打的字检测不到，要随便打个符号再删掉才被识别」——组合被写回打断，字没落进 state；
 *   2. 「检测到后再打几个字发送，新字不见了」——发送前的某次无关重渲染（会话流式、思考
 *      计时器、ResizeObserver）把旧 `value` 写回，盖掉了刚输入的字。
 * 桌面/PWA 浏览器（Chrome 等）容忍组合期的 `.value` 写入，无此问题。
 *
 * 因此按环境分两套策略（判定走 lib/environment.ts，区分原生 App vs dev/PWA/web）：
 *
 * - **浏览器（dev / PWA / web）**：保持完全受控（渲染 `value={value}`），onChange 无条件把
 *   DOM 值同步回 state（含组合期）。这是浏览器受控 IME 的铁律，去掉会把正在输入的拼音
 *   revert 掉。此路径经开发环境验证可用，保持不动。
 *
 * - **原生 App（Capacitor Android/iOS）**：改为**半受控**（渲染 `defaultValue`，不写 `value`）。
 *   IME 完全拥有 DOM，React 渲染绝不回写 `el.value`，从根源消除组合被打断的问题。
 *   仅在两种情况由本 hook 显式回写 DOM：`value` prop 被外部改动（如发送后清空）且**当前不在
 *   组合期**时，用 useLayoutEffect 对齐一次。用户输入经 onInput/onChange 单向同步进 state，
 *   稳态下 `value` 与 `el.value` 相等，effect 不会触发写入，不打断输入。
 *
 * 返回 { native, handlers }：native 供组件决定渲染 `value` 还是 `defaultValue`；handlers
 * 展开到 <input>/<textarea>。ref 必须指向该元素。
 */
export function useDefensiveTextValue<T extends HTMLInputElement | HTMLTextAreaElement>(
  ref: RefObject<T | null>,
  value: string,
  onValueChange: (value: string) => void,
) {
  const composingRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const native = isNativeApp();

  // 原生半受控：仅当 value prop 与 DOM 分歧（外部改动，如发送清空）且非组合期时，对齐 DOM。
  // 稳态输入下 value === el.value，不触发写入，故不会打断 IME。浏览器路径完全不进这里。
  useLayoutEffect(() => {
    if (!native) return;
    const el = ref.current;
    if (!el || composingRef.current) return;
    if (el.value !== value) el.value = value;
  }, [native, value, ref]);

  const sync = (next: string) => {
    if (next !== valueRef.current) onValueChange(next);
  };

  // 读「下一帧稳定后」的真实 DOM 值，补齐安卓预测/滑行滞后的字符（仅原生 App，且非组合期）。
  const reconcileNextFrame = () => {
    if (!native) return;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || composingRef.current) return;
      if (el.value !== valueRef.current) onValueChange(el.value);
    });
  };

  return {
    native,
    handlers: {
      // 浏览器路径依赖它把 DOM 值持续写回 state（含组合期），否则受控 input 会 revert
      // 正在输入的 IME 拼音；原生路径它只做单向同步，不触发 DOM 回写。
      onChange: (e: React.ChangeEvent<T>) => {
        sync(e.target.value);
      },
      onInput: (e: React.FormEvent<T>) => {
        sync((e.target as T).value);
        // 组合期不排 rAF（等 compositionend 再补），非组合期仅原生补齐尾字。
        if (!composingRef.current) reconcileNextFrame();
      },
      onCompositionStart: () => {
        composingRef.current = true;
      },
      onCompositionEnd: (e: React.CompositionEvent<T>) => {
        composingRef.current = false;
        // 组合结束以最终 DOM 值为准同步一次。
        sync((e.target as T).value);
      },
      onBlur: (e: React.FocusEvent<T>) => {
        sync(e.target.value);
      },
    },
  };
}
