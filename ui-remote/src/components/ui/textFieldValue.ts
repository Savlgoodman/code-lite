import { useEffect, useRef, useLayoutEffect, type RefObject } from "react";
import { isNativeApp } from "../../lib/environment";

const NATIVE_VALUE_POLL_MS = 32;

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
 *   只有输入框失焦后，`value` prop 的外部改动（如发送后清空）才由 useLayoutEffect 回写 DOM。
 *   用户输入优先经事件同步；聚焦期间还会低成本轮询 DOM value，覆盖不派发
 *   input/change/compositionend 的安卓输入法。由于原生路径不渲染 `value`，组合期间同步 state
 *   也不会回写 DOM 或打断候选词。
 *
 * 返回 { native, composingRef, handlers }：native 供组件决定渲染 `value` 还是 `defaultValue`；
 * composingRef 供 TextArea 判断回车是否处于选词期；handlers 展开到 <input>/<textarea>。
 * ref 必须指向该元素。
 */
export function useDefensiveTextValue<T extends HTMLInputElement | HTMLTextAreaElement>(
  ref: RefObject<T | null>,
  value: string,
  onValueChange: (value: string) => void,
) {
  const composingRef = useRef(false);
  const focusedRef = useRef(false);
  const valueRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  valueRef.current = value;
  onValueChangeRef.current = onValueChange;
  const native = isNativeApp();

  // 某些安卓输入法只改 DOM value，不稳定派发 React 能收到的输入/组合事件。原生 App 的
  // textarea/input 是半受控的，因此聚焦期间可直接轮询 DOM 真值，不会触发 React 回写。
  useEffect(() => {
    if (!native) return;
    const el = ref.current;
    if (!el) return;

    let timer: number | null = null;
    let blurFrame: number | null = null;
    const reconcile = () => {
      if (el.value !== valueRef.current) onValueChangeRef.current(el.value);
    };
    const start = () => {
      focusedRef.current = true;
      if (blurFrame !== null) {
        cancelAnimationFrame(blurFrame);
        blurFrame = null;
      }
      reconcile();
      if (timer === null) timer = window.setInterval(reconcile, NATIVE_VALUE_POLL_MS);
    };
    const stop = () => {
      focusedRef.current = false;
      composingRef.current = false;
      reconcile();
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      // onValueChange 可能会过滤字符且返回相同 state，React 此时不会重渲染；失焦后一帧
      // 主动对齐一次，既清掉被过滤的 DOM 字符，也不会干扰已经结束的 IME 组合。
      blurFrame = requestAnimationFrame(() => {
        blurFrame = null;
        if (document.activeElement !== el && el.value !== valueRef.current) {
          el.value = valueRef.current;
        }
      });
    };

    el.addEventListener("focus", start);
    el.addEventListener("blur", stop);
    if (document.activeElement === el) start();

    return () => {
      el.removeEventListener("focus", start);
      el.removeEventListener("blur", stop);
      if (timer !== null) window.clearInterval(timer);
      if (blurFrame !== null) cancelAnimationFrame(blurFrame);
      focusedRef.current = false;
    };
  }, [native, ref]);

  // 原生半受控：输入框聚焦期间 DOM 拥有绝对控制权，即使输入法没有派发 compositionstart，
  // React 也不会把稍旧的 state 写回并吞掉尾字。失焦后的外部改动（如发送清空）才对齐 DOM。
  useLayoutEffect(() => {
    if (!native) return;
    const el = ref.current;
    if (!el || focusedRef.current || composingRef.current) return;
    if (el.value !== value) el.value = value;
  }, [native, value, ref]);

  const sync = (next: string) => {
    if (next !== valueRef.current) onValueChangeRef.current(next);
  };

  // 读「下一帧稳定后」的真实 DOM 值，补齐安卓预测/滑行滞后的字符。原生路径半受控，
  // 组合期间同步 state 也不会把旧 value 写回 DOM，因此无需跳过。
  const reconcileNextFrame = () => {
    if (!native) return;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      if (el.value !== valueRef.current) onValueChangeRef.current(el.value);
    });
  };

  return {
    native,
    composingRef,
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
      onCompositionUpdate: (e: React.CompositionEvent<T>) => {
        if (native) sync((e.target as T).value);
      },
      onBlur: (e: React.FocusEvent<T>) => {
        // 部分安卓输入法不派发 compositionend，失焦必须解除组合态。
        composingRef.current = false;
        sync(e.target.value);
      },
    },
  };
}
