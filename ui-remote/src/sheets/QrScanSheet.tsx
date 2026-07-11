import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Sheet, Button } from "../components/ui";

export interface ParsedPairing {
  name: string;
  relayUrl: string;
  pairKey: string;
}

export interface QrScanSheetProps {
  onClose: () => void;
  /** 扫码解析成功后回调，携带配对信息 */
  onDetected: (pairing: ParsedPairing) => void;
}

/**
 * 解析桌面端配对二维码。支持两种载荷：
 * 1. codelite://pair?relay=<编码后relay>&key=<pairKey>&name=<可选名称>
 * 2. 纯 JSON：{ "relay": "...", "key": "...", "name": "..." }
 */
export function parsePairingPayload(raw: string): ParsedPairing | null {
  const text = raw.trim();
  if (!text) return null;

  // 尝试 JSON
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      const relayUrl = String(obj.relay ?? obj.relayUrl ?? "").trim();
      const pairKey = String(obj.key ?? obj.pairKey ?? "").trim();
      if (relayUrl && pairKey) {
        return { name: String(obj.name ?? "").trim(), relayUrl, pairKey };
      }
    } catch {
      /* 非 JSON，继续按 URL 解析 */
    }
  }

  // 尝试 codelite://pair?relay=...&key=...
  try {
    const qIndex = text.indexOf("?");
    const query = qIndex >= 0 ? text.slice(qIndex + 1) : text;
    const params = new URLSearchParams(query);
    const relayUrl = (params.get("relay") ?? "").trim();
    const pairKey = (params.get("key") ?? "").trim();
    if (relayUrl && pairKey) {
      return { name: (params.get("name") ?? "").trim(), relayUrl, pairKey };
    }
  } catch {
    /* ignore */
  }

  return null;
}

export function QrScanSheet({ onClose, onDetected }: QrScanSheetProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectedRef = useRef(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || detectedRef.current) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w > 0 && h > 0) {
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h);
            const image = ctx.getImageData(0, 0, w, h);
            const result = jsQR(image.data, w, h, { inversionAttempts: "dontInvert" });
            if (result?.data) {
              const parsed = parsePairingPayload(result.data);
              if (parsed) {
                detectedRef.current = true;
                stop();
                onDetected(parsed);
                return;
              }
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("当前环境不支持摄像头，请手动输入配对信息");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.setAttribute("playsinline", "true");
          await video.play().catch(() => {});
        }
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError") {
          setError("未获得摄像头权限，请在系统设置中允许后重试");
        } else if (name === "NotFoundError") {
          setError("未检测到摄像头设备");
        } else {
          setError("无法打开摄像头，请检查权限或改用手动输入");
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Sheet
      title="扫码连接"
      onClose={onClose}
      footer={(close) => (
        <Button variant="secondary" onClick={() => close()}>
          取消
        </Button>
      )}
    >
      {error ? (
        <div className="qr-scan-error">{error}</div>
      ) : (
        <div className="qr-scan-viewport">
          <video ref={videoRef} className="qr-scan-video" muted playsInline />
          <div className="qr-scan-frame" />
          <p className="qr-scan-hint">将二维码对准取景框</p>
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </Sheet>
  );
}
