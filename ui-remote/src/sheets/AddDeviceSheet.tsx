import { useState, useEffect } from "react";
import { QrCode } from "lucide-react";
import { RelayTransport } from "../services/RelayTransport";
import { computeRoomId } from "../services/ConnectionManager";
import type { DeviceRecord } from "../services/DeviceStore";
import { Sheet, Button, Input } from "../components/ui";
import { QrScanSheet } from "./QrScanSheet";

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
  const [showScan, setShowScan] = useState(false);

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
    <Sheet
      title={title}
      onClose={onClose}
      footer={(close) => (
        <>
          <Button
            variant="secondary"
            onClick={handleTest}
            disabled={testing || !relayUrl.trim() || !pairKey.trim()}
          >
            {testing ? "测试中..." : "测试连接"}
          </Button>
          <Button
            variant="primary"
            onClick={() => allFilled && close(handleSave)}
            disabled={!allFilled}
          >
            {isEdit ? "保存修改" : "保存"}
          </Button>
        </>
      )}
    >
      {!isEdit && (
        <button type="button" className="qr-scan-trigger" onClick={() => setShowScan(true)}>
          <QrCode size={18} />
          <span>扫码连接</span>
        </button>
      )}
      <div className="field">
        <label>设备名称</label>
        <Input
          type="text"
          placeholder="如: 客厅台式机"
          value={name}
          onValueChange={setName}
        />
      </div>
      <div className="field">
        <label>Relay 地址</label>
        <Input
          type="url"
          placeholder="wss://relay.example.com"
          value={relayUrl}
          onValueChange={setRelayUrl}
        />
      </div>
      <div className="field">
        <label>Pair Key</label>
        <Input
          type="text"
          placeholder="输入 32 位配对密钥"
          value={pairKey}
          onValueChange={setPairKey}
          autoComplete="off"
        />
      </div>
      {testResult === "success" && (
        <div className="test-result success">✓ 连接成功</div>
      )}
      {testResult === "fail" && (
        <div className="test-result fail"> 连接失败: {testError}</div>
      )}
      {showScan && (
        <QrScanSheet
          onClose={() => setShowScan(false)}
          onDetected={(pairing) => {
            setRelayUrl(pairing.relayUrl);
            setPairKey(pairing.pairKey);
            if (pairing.name) setName(pairing.name);
            setTestResult("idle");
            setTestError("");
            setShowScan(false);
          }}
        />
      )}
    </Sheet>
  );
}
