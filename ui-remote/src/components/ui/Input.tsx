import { useRef, forwardRef, type InputHTMLAttributes } from "react";
import { useDefensiveTextValue } from "./textFieldValue";

/**
 * Input — 防御式单行文本输入原子。
 *
 * 收表单值一律用它，别用裸 <input>：安卓 WebView 开着输入法预测/滑行/联想时，
 * 联想词落进 DOM 却不一定触发 React 的 change 事件（或滞后一字），表现为「刚打的字
 * 检测不到，要删一个字才识别」。取值逻辑集中在 useDefensiveTextValue（组合感知 + rAF 兜底）。
 *
 * 对上层 API：传 value + onValueChange，其余原生属性透传。
 */

interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: string;
  onValueChange: (value: string) => void;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { value, onValueChange, className = "", ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);

  const setRef = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  const { native, handlers } = useDefensiveTextValue(innerRef, value, onValueChange);

  // 原生 App 半受控（defaultValue，DOM 回写交给 hook 的 layout effect），避免 IME 组合被
  // React 每次渲染的受控回写打断；浏览器完全受控（value）。见 useDefensiveTextValue。
  return (
    <input
      ref={setRef}
      className={`form-input ${className}`.trim()}
      {...(native ? { defaultValue: value } : { value })}
      {...handlers}
      {...rest}
    />
  );
});
