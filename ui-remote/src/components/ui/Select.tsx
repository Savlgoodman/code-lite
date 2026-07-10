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
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

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
    <div className={`select${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="select-trigger"
        onClick={() => setOpen((v) => !v)}
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
