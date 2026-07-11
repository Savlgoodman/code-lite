import { useState, useEffect } from "react";
import { aiProviderStore, type AiProvider, type AiModel } from "../services/AiProviderStore";

/** 订阅供应商 + 模型列表；store 变更时重新加载。 */
export function useAiProviders(): { providers: AiProvider[]; models: AiModel[]; reload: () => void } {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [p, m] = await Promise.all([
        aiProviderStore.loadProviders(),
        aiProviderStore.loadModels(),
      ]);
      if (!cancelled) {
        setProviders(p);
        setModels(m);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    return aiProviderStore.subscribe(() => setVersion((v) => v + 1));
  }, []);

  return { providers, models, reload: () => setVersion((v) => v + 1) };
}
