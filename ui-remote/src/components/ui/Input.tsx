import { useRef, forwardRef, type InputHTMLAttributes } from "react";

/**
 * Input — 防御式文本输入原子。
 *
 * 为什么不用裸 <input onChange>：安卓 WebView（Capacitor，且 capacitor.config
 * 开了 captureInput）下，粘贴 / 输入法联想 / 自动填充有时会改动 input 的 value
 * 却不派发 React 绑定的 change 事件，导致受控 state 不更新——表现为「粘贴 URL/Key
 * 后保存按钮一直灰」。这里同时监听 onChange 与 onInput，并在 onBlur / onPaste 后用
 * rAF 兜底读取真实 el.value，确保任何来源的值变化都能同步到上层。
 *
 * 对上层 API 与原生 input 一致：只需传 value + onValueChange。
 * 其余原生属性（placeholder / type / inputMode 等）透传。
 */

interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  /** 值变化回调（合并了 change/input/兜底读取）。 */
  onValueChange: (value: string) => void;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { value, onValueChange, onBlur, onPaste, className = "", ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);

  const setRef = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  // 兜底：某些安卓 WebView 路径下事件值滞后，下一帧读真实 DOM 值补齐。
  const syncFromDom = () => {
    requestAnimationFrame(() => {
      const el = innerRef.current;
      if (el && el.value !== value) onValueChange(el.value);
    });
  };

  return (
    <input
      ref={setRef}
      className={`form-input ${className}`.trim()}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      onInput={(e) => {
        const next = (e.target as HTMLInputElement).value;
        if (next !== value) onValueChange(next);
      }}
      onPaste={(e) => {
        onPaste?.(e);
        syncFromDom();
      }}
      onBlur={(e) => {
        onBlur?.(e);
        if (e.target.value !== value) onValueChange(e.target.value);
      }}
      {...rest}
    />
  );
});
