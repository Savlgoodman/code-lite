import { useRef, type RefObject } from "react";

/**
 * useDefensiveTextValue — 受控文本输入的防御式取值逻辑（input 与 textarea 共用）。
 *
 * 为什么需要：安卓 WebView 下开着输入法预测 / 滑行输入 / 自动补全时，联想词落进 DOM
 * 却不一定派发 React 绑定的 change 事件，或事件里的 value 滞后一个字——表现为「刚打的字
 * 检测不到，要删一个字才被识别」。PWA/桌面浏览器无此问题。
 *
 * 对策（不与 IME 对抗）：
 * - 组合输入期间（compositionstart→compositionend）不打断，结束时读真实 DOM 值同步。
 * - 非组合期的 change/input 都取值；并在每次 input 后用 rAF 兜底读一次「本帧稳定后的
 *   DOM 值」，补上事件里滞后/缺失的尾字。
 * - blur 时再兜底一次。
 *
 * 返回一组事件处理器，展开到 <input>/<textarea> 即可。ref 必须指向该元素。
 */
export function useDefensiveTextValue<T extends HTMLInputElement | HTMLTextAreaElement>(
  ref: RefObject<T | null>,
  value: string,
  onValueChange: (value: string) => void,
) {
  const composingRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  // 读「下一帧稳定后」的真实 DOM 值，补齐事件里滞后/缺失的字符。
  const reconcileNextFrame = () => {
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || composingRef.current) return;
      if (el.value !== valueRef.current) onValueChange(el.value);
    });
  };

  return {
    onChange: (e: React.ChangeEvent<T>) => {
      if (composingRef.current) return;
      if (e.target.value !== valueRef.current) onValueChange(e.target.value);
    },
    onInput: (e: React.FormEvent<T>) => {
      if (composingRef.current) return;
      const next = (e.target as T).value;
      if (next !== valueRef.current) onValueChange(next);
      reconcileNextFrame();
    },
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: (e: React.CompositionEvent<T>) => {
      composingRef.current = false;
      const next = (e.target as T).value;
      if (next !== valueRef.current) onValueChange(next);
    },
    onBlur: (e: React.FocusEvent<T>) => {
      if (e.target.value !== valueRef.current) onValueChange(e.target.value);
    },
  };
}
