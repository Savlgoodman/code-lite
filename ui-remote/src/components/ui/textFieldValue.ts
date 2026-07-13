import { useRef, type RefObject } from "react";
import { isNativeApp } from "../../lib/environment";

/**
 * useDefensiveTextValue — 受控文本输入的防御式取值逻辑（input 与 textarea 共用）。
 *
 * 为什么需要：安卓 WebView 下开着输入法预测 / 滑行输入 / 自动补全时，联想词落进 DOM
 * 却不一定派发 React 绑定的 change 事件，或事件里的 value 滞后一个字——表现为「刚打的字
 * 检测不到，要删一个字才被识别」。PWA/桌面浏览器无此问题。
 *
 * 关键正确性约束（受控组件铁律）：
 * onChange 必须**无条件**把当前 DOM 值同步回 state，**包括 IME 组合期**。因为受控
 * `<input value>` 每次渲染都把 value 强加到 DOM，若组合期不同步，React 会把正在输入的
 * 拼音 revert 掉——中文 / 日文等 IME 直接打不了字。组合状态只用于「回车是否算发送」的
 * 判断（见 TextArea 的 onEnter / keyCode 229），绝不能用它来吞 onChange。
 *
 * rAF 兜底（input 后读「本帧稳定后的 DOM 值」补齐安卓预测滞后的尾字）**只在原生 App 启用**：
 * 桌面 / PWA 的受控 input 从不丢字，无需兜底。
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
  const native = isNativeApp();

  // 读「下一帧稳定后」的真实 DOM 值，补齐安卓预测/滑行滞后的字符（仅原生 App，且非组合期）。
  const reconcileNextFrame = () => {
    if (!native) return;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || composingRef.current) return;
      if (el.value !== valueRef.current) onValueChange(el.value);
    });
  };

  const sync = (next: string) => {
    if (next !== valueRef.current) onValueChange(next);
  };

  return {
    // 无条件同步：受控 input 依赖它持续把 DOM 值写回 state（含组合期），否则 React 会
    // revert 正在输入的 IME 拼音。
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
  };
}
