import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * 自定义下拉选择器：原生 select 的选项面板无法跨端定制样式，
 * 这里用可展开的内联列表替代，避免被 Sheet 的滚动容器裁剪。
 */
export function Select({ value, options, onChange, placeholder = "请选择" }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value);

  // 展开前按可用空间决定向上还是向下弹：面板绝对定位悬浮，
  // 靠近抽屉底部（如访问模式）空间不足时向上弹，避免被 Sheet 底部/footer 裁剪。
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        // 以最近的滚动容器（抽屉 body）为边界，无则退回视口
        const scroller = rootRef.current?.closest(".modal-body") as HTMLElement | null;
        const bounds = scroller?.getBoundingClientRect();
        const bottomEdge = bounds ? bounds.bottom : window.innerHeight;
        const topEdge = bounds ? bounds.top : 0;
        const spaceBelow = bottomEdge - rect.bottom;
        const spaceAbove = rect.top - topEdge;
        const need = Math.min(240, options.length * 44 + 8);
        setDropUp(spaceBelow < need && spaceAbove > spaceBelow);
      }
      return next;
    });
  };

  // 点击面板外部时收起
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, [open]);

  return (
    <div className={`select${open ? " open" : ""}${dropUp ? " drop-up" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`select-value${selected ? "" : " placeholder"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="select-chevron" size={18} />
      </button>
      {open && (
        <ul className="select-panel" role="listbox">
          {options.map((opt) => {
            const isSel = opt.value === value;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSel}
                className={`select-option${isSel ? " selected" : ""}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                {isSel && <Check size={16} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
