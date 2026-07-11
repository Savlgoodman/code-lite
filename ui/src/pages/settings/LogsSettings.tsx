import { useEffect, useState } from "react";

import { ChevronRight, FileText, RefreshCw } from "lucide-react";

import { loadLogFiles, loadLogTail } from "../../services/settingsStore";
import type { LogEntry, LogFileInfo } from "../../types";
import { SettingsSelect } from "./components/SettingsSelect";
import type { SettingsSelectOption } from "./components/SettingsSelect";

const logCategoryOptions = [
  { label: "全部", value: "all" },
  { label: "ACP", value: "acp" },
  { label: "API", value: "api" },
  { label: "Python", value: "python" },
  { label: "Runtime stderr", value: "runtime.stderr" },
  { label: "诊断", value: "diagnostic" }
] satisfies Array<SettingsSelectOption<string>>;

const logLevelOptions = [
  { label: "全部", value: "all" },
  { label: "Error", value: "error" },
  { label: "Warning", value: "warning" },
  { label: "Info", value: "info" },
  { label: "Debug", value: "debug" }
] satisfies Array<SettingsSelectOption<string>>;

function logCategoryLabel(value?: string) {
  return logCategoryOptions.find((item) => item.value === value)?.label ?? value ?? "日志";
}

function logCategoryClass(value?: string) {
  const normalized = (value ?? "python").replace(".", "-");
  return `log-category-${normalized}`;
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const category = entry.category ?? "python";
  return (
    <article className={`settings-log-entry ${logCategoryClass(category)}`}>
      <button className="settings-log-entry-main" onClick={() => setExpanded((current) => !current)} type="button">
        <span className="settings-log-time">{entry.timestamp ?? "--"}</span>
        <span className="settings-log-level">{entry.level ?? "info"}</span>
        <span className="settings-log-category">{logCategoryLabel(category)}</span>
        <span className="settings-log-message">{entry.message ?? ""}</span>
        <ChevronRight className={expanded ? "expanded" : ""} size={14} />
      </button>
      <div className="settings-log-meta">
        {entry.runtime ? <span>runtime: {entry.runtime}</span> : null}
        {entry.stage ? <span>stage: {entry.stage}</span> : null}
        {entry.conversationId ? <span>conversation: {entry.conversationId}</span> : null}
        {entry.turnId ? <span>turn: {entry.turnId}</span> : null}
      </div>
      {expanded ? (
        <pre className="settings-log-detail">{compactJson(entry)}</pre>
      ) : null}
    </article>
  );
}

function LogFilePill({ file }: { file: LogFileInfo }) {
  return (
    <div className={`settings-log-file ${logCategoryClass(file.category)}`}>
      <span>{logCategoryLabel(file.category)}</span>
      <strong>{file.exists ? file.size : "未生成"}</strong>
    </div>
  );
}

export function LogsSettings() {
  const [category, setCategory] = useState("all");
  const [level, setLevel] = useState("all");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [logsDir, setLogsDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function refreshLogs() {
    setIsLoading(true);
    setError(null);
    try {
      const [nextFiles, tail] = await Promise.all([
        loadLogFiles(),
        loadLogTail({ category, level, query, limit: 500 })
      ]);
      setFiles(nextFiles.files);
      setLogsDir(tail.logsDir || nextFiles.logsDir);
      setEntries(tail.entries);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refreshLogs();
  }, []);

  return (
    <section className="settings-content-column">
      <div className="settings-page-heading with-action">
        <div>
          <span className="eyebrow">诊断</span>
          <h1>日志</h1>
        </div>
        <button className="settings-secondary-button" disabled={isLoading} onClick={() => void refreshLogs()} type="button">
          <RefreshCw className={isLoading ? "spin-icon" : ""} size={14} />
          <span>刷新</span>
        </button>
      </div>

      {error ? <div className="settings-inline-error">日志读取失败：{error}</div> : null}

      <div className="settings-card settings-log-toolbar">
        <label className="settings-field">
          <span>分类</span>
          <SettingsSelect onChange={setCategory} options={logCategoryOptions} value={category} />
        </label>
        <label className="settings-field">
          <span>等级</span>
          <SettingsSelect onChange={setLevel} options={logLevelOptions} value={level} />
        </label>
        <label className="settings-field settings-field-wide">
          <span>搜索</span>
          <input onChange={(event) => setQuery(event.target.value)} placeholder="conversationId / turnId / stage / message" value={query} />
        </label>
        <button className="settings-primary-button" disabled={isLoading} onClick={() => void refreshLogs()} type="button">
          <span>应用筛选</span>
        </button>
      </div>

      <div className="settings-card">
        <div className="settings-storage-head">
          <FileText size={16} />
          <strong>日志目录</strong>
          <span>{logsDir || "待检测"}</span>
        </div>
        <div className="settings-log-files">
          {files.map((file) => <LogFilePill file={file} key={file.category} />)}
        </div>
      </div>

      <div className="settings-log-list">
        {entries.length === 0 ? (
          <div className="settings-empty">暂无日志</div>
        ) : entries.map((entry, index) => (
          <LogEntryRow entry={entry} key={entry.id ?? `${entry.timestamp}-${index}`} />
        ))}
      </div>
    </section>
  );
}
