import { useEffect, useState } from "react";
import { imageProviderStore, type ImageProviderRecord } from "../services/ImageProviderStore";

/** 订阅图片生成供应商列表；store 变更时重新加载。 */
export function useImageProviders(): { providers: ImageProviderRecord[]; reload: () => void } {
  const [providers, setProviders] = useState<ImageProviderRecord[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void imageProviderStore.loadProviders().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    return imageProviderStore.subscribe(() => setVersion((v) => v + 1));
  }, []);

  return { providers, reload: () => setVersion((v) => v + 1) };
}
