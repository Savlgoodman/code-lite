import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { imageBlobStore } from "../services/imageBlobStore";

interface BlobImageProps {
  imageId: string | null | undefined;
  alt: string;
  className?: string;
  onClick?: () => void;
  onLongPress?: () => void;
}

const LONG_PRESS_MS = 550;

/**
 * 按 imageId 从 IndexedDB 取 Blob 转 objectURL 渲染。
 * 卸载或 id 变更时释放上一个 objectURL，避免内存泄漏。
 */
export function BlobImage({ imageId, alt, className, onClick, onLongPress }: BlobImageProps) {
  const [url, setUrl] = useState<string>("");
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const suppressResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    if (!imageId) {
      setUrl("");
      return;
    }
    void imageBlobStore.getImage(imageId).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    if (suppressResetTimerRef.current !== null) window.clearTimeout(suppressResetTimerRef.current);
  }, []);

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function triggerLongPress() {
    if (!onLongPress || suppressClickRef.current) return;
    suppressClickRef.current = true;
    onLongPress();
    suppressResetTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressResetTimerRef.current = null;
    }, 1_000);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLImageElement>) {
    if (!onLongPress || (event.pointerType === "mouse" && event.button !== 0)) return;
    clearLongPressTimer();
    suppressClickRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      triggerLongPress();
    }, LONG_PRESS_MS);
  }

  function handleClick(event: ReactMouseEvent<HTMLImageElement>) {
    if (suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
      if (suppressResetTimerRef.current !== null) window.clearTimeout(suppressResetTimerRef.current);
      suppressResetTimerRef.current = null;
      return;
    }
    onClick?.();
  }

  function handleContextMenu(event: ReactMouseEvent<HTMLImageElement>) {
    if (!onLongPress) return;
    event.preventDefault();
    clearLongPressTimer();
    triggerLongPress();
  }

  if (!url) return null;
  return (
    <img
      alt={alt}
      className={className}
      src={url}
      draggable={false}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
    />
  );
}
