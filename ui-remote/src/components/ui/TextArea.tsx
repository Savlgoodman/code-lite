import { useRef, forwardRef, type TextareaHTMLAttributes } from "react";
import { useDefensiveTextValue } from "./textFieldValue";

/**
 * TextArea — 防御式多行文本输入原子（消息输入框等）。
 *
 * 与 Input 同源：解决安卓 WebView 输入法预测/滑行/联想时值不触发或滞后的问题
 * （见 useDefensiveTextValue）。收多行文本值一律用它，别用裸 <textarea>。
 *
 * onEnter：非组合输入期按下 Enter（未按 Shift）时触发，供「回车发送」用；组合输入
 * 期间的 Enter 是输入法在选词，不会触发，避免误发。仍需自定义键处理可另传 onKeyDown。
 */

interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onValueChange: (value: string) => void;
  /** 非组合期回车（未按 Shift）回调。返回后默认已 preventDefault。 */
  onEnter?: () => void;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { value, onValueChange, onEnter, onKeyDown, className = "", ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);

  const setRef = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  const { native, handlers } = useDefensiveTextValue(innerRef, value, onValueChange);

  // 原生 App 半受控（defaultValue），浏览器完全受控（value）。见 useDefensiveTextValue。
  return (
    <textarea
      ref={setRef}
      className={className}
      {...(native ? { defaultValue: value } : { value })}
      {...handlers}
      onCompositionStart={(e) => {
        composingRef.current = true;
        handlers.onCompositionStart();
        void e;
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        handlers.onCompositionEnd(e);
      }}
      onKeyDown={(e) => {
        // 组合输入（IME 选词）期间的 Enter 不当作发送。
        // e.keyCode === 229 是部分安卓输入法组合中的哨兵值。
        if (onEnter && e.key === "Enter" && !e.shiftKey && !composingRef.current && e.keyCode !== 229) {
          e.preventDefault();
          onEnter();
          return;
        }
        onKeyDown?.(e);
      }}
      {...rest}
    />
  );
});
