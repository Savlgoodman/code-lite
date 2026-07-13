import { useEffect, useState } from "react";

import { resolveImageUrl } from "../../services/imageGenStore";

interface AsyncImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  onClick?: () => void;
}

/** 后端图片路径需拼接 base_url；用异步解析后再渲染 <img>。 */
export function AsyncImage({ src, alt, className, onClick }: AsyncImageProps) {
  const [resolved, setResolved] = useState("");

  useEffect(() => {
    let cancelled = false;
    void resolveImageUrl(src).then((url) => {
      if (!cancelled) {
        setResolved(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!resolved) {
    return null;
  }
  return <img alt={alt} className={className} onClick={onClick} src={resolved} />;
}
