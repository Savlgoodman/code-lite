import { useState } from "react";
import type { SessionConfig } from "../hooks/useSessionConfig";

export interface ConfigSheetProps {
  config: SessionConfig;
  onClose: () => void;
  onSave: (config: SessionConfig) => void;
}

export function ConfigSheet({ config, onClose, onSave }: ConfigSheetProps) {
  const [local, setLocal] = useState(config);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>会话配置</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* 模型选择 — 始终显示（codex 显示族，claude 显示单个模型） */}
          {local.grouping.families.length > 0 && (
            <div className="field">
              <label>模型</label>
              <select value={local.familyId} onChange={(e) => setLocal({ ...local, familyId: e.target.value })}>
                {local.grouping.families.map((fam) => (
                  <option key={fam.familyId} value={fam.familyId}>{fam.label}</option>
                ))}
              </select>
            </div>
          )}
          {/* 思考强度 */}
          <div className="field">
            <label>思考强度</label>
            <select value={local.effort} onChange={(e) => setLocal({ ...local, effort: e.target.value })}>
              {local.grouping.isGrouped
                ? local.grouping.families.find((f) => f.familyId === local.familyId)?.efforts.map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))
                : local.configOptionsRaw.find((o) => o.id === "reasoning_effort")?.values?.map((v) => (
                    <option key={String(v)} value={String(v)}>{String(v)}</option>
                  ))
              }
            </select>
          </div>
          {/* 访问模式 */}
          {local.modes.length > 0 && (
            <div className="field">
              <label>访问模式</label>
              <select value={local.accessMode} onChange={(e) => setLocal({ ...local, accessMode: e.target.value })}>
                {local.modes.map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => onSave(local)}>保存</button>
        </div>
      </div>
    </div>
  );
}
