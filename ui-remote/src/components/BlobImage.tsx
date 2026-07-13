import { useEffect, useState } from "react";
import { imageBlobStore } from "../services/imageBlobStore";

interface BlobImageProps {
  imageId: string | null | undefined;
  alt: string;
  className?: string;
  onClick?: () => void;
}

/**
 * 按 imageId 从 IndexedDB 取 Blob 转 objectURL 渲染。
 * 卸载或 id 变更时释放上一个 objectURL，避免内存泄漏。
 */
export function BlobImage({ imageId, alt, className, onClick }: BlobImageProps) {
  const [url, setUrl] = useState<string>("");

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

  if (!url) return null;
  return <img alt={alt} className={className} src={url} onClick={onClick} />;
}
