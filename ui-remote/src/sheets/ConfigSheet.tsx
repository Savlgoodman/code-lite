import { useState } from "react";
import type { SessionConfig } from "../hooks/useSessionConfig";
import { Sheet, Button, Select } from "../components/ui";

export interface ConfigSheetProps {
  config: SessionConfig;
  onClose: () => void;
  onSave: (config: SessionConfig) => void;
}

export function ConfigSheet({ config, onClose, onSave }: ConfigSheetProps) {
  const [local, setLocal] = useState(config);

  // 思考强度候选：分组模型取当前族的 efforts，否则取 reasoning_effort 选项值
  const effortOptions: string[] = local.grouping.isGrouped
    ? local.grouping.families.find((f) => f.familyId === local.familyId)?.efforts ?? []
    : (local.configOptionsRaw.find((o) => o.id === "reasoning_effort")?.values ?? []).map((v) => String(v));

  return (
    <Sheet
      title="会话配置"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => onSave(local)}>保存</Button>
        </>
      }
    >
      {/* 模型选择 — 始终显示（codex 显示族，claude 显示单个模型） */}
      {local.grouping.families.length > 0 && (
        <div className="field">
          <label>模型</label>
          <Select
            value={local.familyId}
            onChange={(v) => setLocal({ ...local, familyId: v })}
            options={local.grouping.families.map((fam) => ({ value: fam.familyId, label: fam.label }))}
          />
        </div>
      )}
      {/* 思考强度 */}
      <div className="field">
        <label>思考强度</label>
        <Select
          value={local.effort}
          onChange={(v) => setLocal({ ...local, effort: v })}
          options={effortOptions.map((id) => ({ value: id, label: id }))}
        />
      </div>
      {/* 访问模式 */}
      {local.modes.length > 0 && (
        <div className="field">
          <label>访问模式</label>
          <Select
            value={local.accessMode}
            onChange={(v) => setLocal({ ...local, accessMode: v })}
            options={local.modes.map((mode) => ({ value: mode.id, label: mode.label }))}
          />
        </div>
      )}
    </Sheet>
  );
}
