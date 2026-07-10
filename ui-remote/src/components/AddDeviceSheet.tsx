import { useState, useEffect } from "react";
import { RelayTransport } from "../services/RelayTransport";
import { computeRoomId } from "../services/ConnectionManager";
import type { DeviceRecord } from "../services/DeviceStore";

export interface AddDeviceSheetProps {
  initial?: DeviceRecord; // 编辑时传入，添加时省略
  onClose: () => void;
  onSave: (name: string, relayUrl: string, pairKey: string) => void;
}

export function AddDeviceSheet({ initial, onClose, onSave }: AddDeviceSheetProps) {
  const [name, setName] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [pairKey, setPairKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"idle" | "success" | "fail">("idle");
  const [testError, setTestError] = useState("");

  const isEdit = Boolean(initial);
  const title = isEdit ? "编辑设备" : "添加设备";

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setRelayUrl(initial.relayUrl);
      setPairKey(initial.pairKey);
    }
  }, [initial]);

  const allFilled = name.trim() && relayUrl.trim() && pairKey.trim();

  const handleTest = async () => {
    if (!relayUrl.trim() || !pairKey.trim()) return;
    setTesting(true);
    setTestResult("idle");
    setTestError("");

    const transport = new RelayTransport({
      relayUrl: relayUrl.trim(),
      roomId: await computeRoomId(pairKey.trim()),
      onHostStatusChange: () => {},
    });

    try {
      await Promise.race([
        transport.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("连接超时")), 10000)),
      ]);
      setTestResult("success");
    } catch (err) {
      setTestResult("fail");
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      transport.close();
      setTesting(false);
    }
  };

  const handleSave = () => {
    if (!allFilled) return;
    onSave(name.trim(), relayUrl.trim(), pairKey.trim());
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>设备名称</label>
            <input
              type="text"
              className="form-input"
              placeholder="如: 客厅台式机"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Relay 地址</label>
            <input
              type="url"
              className="form-input"
              placeholder="wss://relay.example.com"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Pair Key</label>
            <input
              type="text"
              className="form-input"
              placeholder="输入 32 位配对密钥"
              value={pairKey}
              onChange={(e) => setPairKey(e.target.value)}
              autoComplete="off"
            />
          </div>
          {testResult === "success" && (
            <div className="test-result success">✓ 连接成功</div>
          )}
          {testResult === "fail" && (
            <div className="test-result fail"> 连接失败: {testError}</div>
          )}
        </div>
        <div className="modal-footer">
          <button
            className="btn-secondary"
            onClick={handleTest}
            disabled={testing || !relayUrl.trim() || !pairKey.trim()}
          >
            {testing ? "测试中..." : "测试连接"}
          </button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={!allFilled}
          >
            {isEdit ? "保存修改" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
