import { useMemo, useState } from "react";

import { ChevronLeft, ChevronRight } from "lucide-react";

import type { InputRequest } from "../../types";
import "./InputRequestCard.css";

interface InputRequestCardProps {
  request: InputRequest;
  onResolve: (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
}

interface SchemaProperty {
  default?: unknown;
  description?: string;
  enum?: string[];
  items?: {
    anyOf?: Array<{ const?: string; title?: string; _meta?: Record<string, unknown> }>;
    enum?: string[];
    oneOf?: Array<{ const?: string; title?: string; _meta?: Record<string, unknown> }>;
  };
  oneOf?: Array<{ const?: string; title?: string; _meta?: Record<string, unknown> }>;
  title?: string;
  type?: string;
}

type SchemaEntry = [string, SchemaProperty];

interface QuestionPage {
  companion?: SchemaEntry;
  main: SchemaEntry;
}

function schemaProperties(schema: InputRequest["schema"]): Array<[string, SchemaProperty]> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.entries(properties).filter(([, value]) => value && typeof value === "object") as Array<[string, SchemaProperty]>;
}

function optionLabel(option: { const?: string; title?: string }) {
  return option.title || option.const || "选项";
}

function enumOptions(values?: string[]) {
  return values?.map((value) => ({ const: value, title: value })) ?? [];
}

function propertyLabel(key: string, prop: SchemaProperty) {
  return prop.title || prop.description || key;
}

function isCompanionField(key: string, prop: SchemaProperty) {
  const normalizedKey = key.toLowerCase();
  const normalizedTitle = (prop.title || "").trim().toLowerCase();
  return normalizedKey.endsWith("_custom")
    || normalizedKey.endsWith("custom")
    || normalizedTitle === "other";
}

function buildQuestionPages(properties: SchemaEntry[]): QuestionPage[] {
  const pages: QuestionPage[] = [];
  for (let index = 0; index < properties.length; index += 1) {
    const current = properties[index];
    const next = properties[index + 1];
    if (!current) {
      continue;
    }
    const [key, prop] = current;
    if (isCompanionField(key, prop)) {
      pages.push({ main: current });
      continue;
    }
    if (next && isCompanionField(next[0], next[1])) {
      pages.push({ main: current, companion: next });
      index += 1;
      continue;
    }
    pages.push({ main: current });
  }
  return pages;
}

export function InputRequestCard({ request, onResolve }: InputRequestCardProps) {
  const properties = useMemo(() => schemaProperties(request.schema), [request.schema]);
  const pages = useMemo(() => buildQuestionPages(properties), [properties]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentPageIndex = Math.min(currentIndex, Math.max(pages.length - 1, 0));
  const currentPage = pages[currentPageIndex] ?? null;
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const [key, prop] of properties) {
      if (prop.type === "array") {
        initial[key] = [];
      } else if (prop.type === "boolean") {
        initial[key] = false;
      } else if (prop.default != null) {
        initial[key] = prop.default;
      } else {
        initial[key] = "";
      }
    }
    return initial;
  });

  function updateValue(key: string, value: unknown) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function toggleArrayValue(key: string, option: string) {
    setValues((current) => {
      const existing = Array.isArray(current[key]) ? current[key] as string[] : [];
      const next = existing.includes(option)
        ? existing.filter((item) => item !== option)
        : [...existing, option];
      return { ...current, [key]: next };
    });
  }

  function goPrevious() {
    setCurrentIndex((index) => Math.max(index - 1, 0));
  }

  function goNext() {
    setCurrentIndex((index) => Math.min(index + 1, Math.max(pages.length - 1, 0)));
  }

  function renderProperty(key: string, prop: SchemaProperty, role: "main" | "companion" = "main") {
    const label = propertyLabel(key, prop);
    const singleOptions = prop.oneOf ?? enumOptions(prop.enum);
    const multiOptions = prop.items?.anyOf ?? prop.items?.oneOf ?? enumOptions(prop.items?.enum);
    if (prop.type === "array") {
      const selected = Array.isArray(values[key]) ? values[key] as string[] : [];
      return (
        <fieldset className={`input-field ${role === "companion" ? "companion" : ""}`} key={key}>
          <legend>{label}</legend>
          {prop.description && prop.title ? <p>{prop.description}</p> : null}
          <div className="input-options">
            {multiOptions.map((option) => {
              const value = String(option.const ?? option.title ?? "");
              return (
                <label className="input-option" key={value}>
                  <input
                    checked={selected.includes(value)}
                    onChange={() => toggleArrayValue(key, value)}
                    type="checkbox"
                  />
                  <span>{optionLabel(option)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }
    if (singleOptions.length > 0) {
      return (
        <fieldset className={`input-field ${role === "companion" ? "companion" : ""}`} key={key}>
          <legend>{label}</legend>
          {prop.description && prop.title ? <p>{prop.description}</p> : null}
          <div className="input-options">
            {singleOptions.map((option) => {
              const value = String(option.const ?? option.title ?? "");
              return (
                <label className="input-option" key={value}>
                  <input
                    checked={values[key] === value}
                    name={key}
                    onChange={() => updateValue(key, value)}
                    type="radio"
                  />
                  <span>{optionLabel(option)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }
    if (prop.type === "boolean") {
      return (
        <label className={`input-boolean ${role === "companion" ? "companion" : ""}`} key={key}>
          <input
            checked={Boolean(values[key])}
            onChange={(event) => updateValue(key, event.target.checked)}
            type="checkbox"
          />
          <span>{label}</span>
        </label>
      );
    }
    return (
      <label className={`input-text-field ${role === "companion" ? "companion" : ""}`} key={key}>
        <span>{label}</span>
        <input
          onChange={(event) => updateValue(key, event.target.value)}
          type={prop.type === "number" || prop.type === "integer" ? "number" : "text"}
          value={String(values[key] ?? "")}
        />
      </label>
    );
  }

  return (
    <section className="input-request-panel">
      <div className="input-request-pager">
        <button
          className="input-nav-button"
          disabled={currentPageIndex === 0}
          onClick={goPrevious}
          type="button"
        >
          <ChevronLeft size={14} />
          <span>上一个</span>
        </button>
        <div className="input-request-title">
          <span className="eyebrow">需要输入</span>
          <strong>{request.message}</strong>
          {pages.length > 0 ? (
            <span className="input-request-count">{currentPageIndex + 1} / {pages.length}</span>
          ) : null}
        </div>
        <button
          className="input-nav-button right"
          disabled={currentPageIndex >= pages.length - 1}
          onClick={goNext}
          type="button"
        >
          <span>下一个</span>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="input-request-fields">
        {currentPage ? (
          <div className="input-question-page">
            {renderProperty(currentPage.main[0], currentPage.main[1])}
            {currentPage.companion ? renderProperty(currentPage.companion[0], currentPage.companion[1], "companion") : null}
          </div>
        ) : (
          <p className="input-request-empty">当前请求没有可渲染的表单字段。</p>
        )}
      </div>
      <div className="input-request-actions">
        <button onClick={() => onResolve("cancel")} type="button">取消</button>
        <button onClick={() => onResolve("decline")} type="button">跳过</button>
        <button className="primary" onClick={() => onResolve("accept", values)} type="button">
          提交
        </button>
      </div>
    </section>
  );
}
