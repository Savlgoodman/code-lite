import { X } from "lucide-react";
import { useEffect } from "react";

import "./ImagePreview.css";

export type PreviewImage = {
  name: string;
  url: string;
};

interface ImagePreviewProps {
  image: PreviewImage | null;
  onClose: () => void;
}

export function ImagePreview({ image, onClose }: ImagePreviewProps) {
  useEffect(() => {
    if (!image) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [image, onClose]);

  if (!image) {
    return null;
  }

  return (
    <div className="image-preview-backdrop" onClick={onClose} role="presentation">
      <div className="image-preview-shell" onClick={(event) => event.stopPropagation()}>
        <button aria-label="关闭图片预览" className="image-preview-close" onClick={onClose} type="button">
          <X size={18} />
        </button>
        <img alt={image.name} className="image-preview-image" src={image.url} />
      </div>
    </div>
  );
}
