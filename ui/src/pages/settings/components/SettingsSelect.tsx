import { useEffect, useRef, useState } from "react";

import { Check, ChevronDown } from "lucide-react";

export interface SettingsSelectOption<T extends string> {
  label: string;
  title?: string;
  value: T;
}

interface SettingsSelectProps<T extends string> {
  disabled?: boolean;
  isLoading?: boolean;
  onChange: (value: T) => void;
  onOpen?: () => void;
  options: Array<SettingsSelectOption<T>>;
  value: T;
}

export function SettingsSelect<T extends string>({
  disabled = false,
  isLoading = false,
  onChange,
  onOpen,
  options,
  value
}: SettingsSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((item) => item.value === value) ?? options[0] ?? null;

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    window.addEventListener("mousedown", closeOnOutside);
    return () => window.removeEventListener("mousedown", closeOnOutside);
  }, [isOpen]);

  function chooseOption(option: SettingsSelectOption<T>) {
    onChange(option.value);
    setIsOpen(false);
  }

  function toggleOpen() {
    if (disabled) {
      return;
    }
    setIsOpen((current) => {
      const next = !current;
      if (next) {
        onOpen?.();
      }
      return next;
    });
  }

  return (
    <div className={`settings-select ${isOpen ? "open" : ""}`} ref={rootRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="settings-select-button"
        disabled={disabled}
        onClick={toggleOpen}
        type="button"
      >
        <span title={selected?.title ?? selected?.label}>{selected?.label ?? "请选择"}</span>
        <ChevronDown size={14} />
      </button>
      {isOpen ? (
        <div className="settings-select-menu" role="listbox">
          {isLoading ? <div className="settings-select-loading">加载中...</div> : null}
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={`settings-select-option ${option.value === value ? "selected" : ""}`}
              key={option.value}
              onClick={() => chooseOption(option)}
              role="option"
              title={option.title ?? option.label}
              type="button"
            >
              <span>{option.label}</span>
              {option.value === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
