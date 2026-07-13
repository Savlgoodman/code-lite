import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ImageGenValidationError,
  type ImageAsset,
  type ImageGenRecord,
  type ImageGenRequest,
  type ImageGenRun,
  type ImageProvider,
  type ImageQuality
} from "@code-lite/image-gen";

import { getImageGenClient } from "../../services/imageGenStore";
import { loadPromptOptimizeSettings } from "../../services/featureStore";
import { loadModelSettings } from "../../services/settingsStore";
import type { ConfiguredModel } from "../../types";

export interface ImageGenParams {
  providerId: string;
  model: string;
  prompt: string;
  n: number;
  size: string;
  quality: ImageQuality;
}

const DEFAULT_PARAMS: ImageGenParams = {
  providerId: "",
  model: "",
  prompt: "",
  n: 1,
  size: "auto",
  quality: "auto"
};

export interface ImageGenDetailState {
  record: ImageGenRecord | null;
  providers: ImageProvider[];
  textModels: ConfiguredModel[];
  params: ImageGenParams;
  // 当前生成使用的参考图（随选中批次切换恢复，也可继续编辑做二次生成）。
  activeReferenceImages: ImageAsset[];
  selectedRunId: string | null;
  optimizeModelId: string;
  optimizeEnabled: boolean;
  loading: boolean;
  generating: boolean;
  optimizing: boolean;
  uploadingReference: boolean;
  error: string | null;
  setParam: <K extends keyof ImageGenParams>(key: K, value: ImageGenParams[K]) => void;
  setProvider: (providerId: string) => void;
  setOptimizeModelId: (modelId: string) => void;
  selectRun: (runId: string) => void;
  generate: () => Promise<void>;
  optimizePrompt: () => Promise<void>;
  uploadReference: (file: File) => Promise<void>;
  removeReference: (imageId: string) => void;
}

/** 从任务参考图池中按 id 顺序取出资产（缺失的忽略）。 */
function referencesByIds(record: ImageGenRecord | null, ids: string[]): ImageAsset[] {
  if (!record) {
    return [];
  }
  const pool = new Map(record.referenceImages.map((image) => [image.id, image]));
  return ids.map((id) => pool.get(id)).filter((image): image is ImageAsset => Boolean(image));
}

/** 当前选中批次（默认最近一次）。 */
function resolveSelectedRun(record: ImageGenRecord | null, selectedRunId: string | null): ImageGenRun | null {
  if (!record || record.runs.length === 0) {
    return null;
  }
  const found = selectedRunId ? record.runs.find((run) => run.id === selectedRunId) : null;
  return found ?? record.runs[record.runs.length - 1];
}

export function useImageGenDetail(recordId: string, onRecordChanged?: () => void): ImageGenDetailState {
  const client = useMemo(() => getImageGenClient(), []);
  const [record, setRecord] = useState<ImageGenRecord | null>(null);
  const [providers, setProviders] = useState<ImageProvider[]>([]);
  const [textModels, setTextModels] = useState<ConfiguredModel[]>([]);
  const [params, setParams] = useState<ImageGenParams>(DEFAULT_PARAMS);
  // 当前参考图工作集（按 id 记录）：随选中批次恢复，上传/删除时更新。
  const [activeReferenceIds, setActiveReferenceIds] = useState<string[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [optimizeModelId, setOptimizeModelId] = useState("");
  const [optimizeEnabled, setOptimizeEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paramsInitialized = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    paramsInitialized.current = false;

    async function boot() {
      try {
        const [loadedRecord, loadedProviders, modelSettings, featureSettings] = await Promise.all([
          client.getRecord(recordId),
          client.listProviders(),
          loadModelSettings().catch(() => null),
          loadPromptOptimizeSettings().catch(() => null)
        ]);
        if (cancelled) {
          return;
        }
        setRecord(loadedRecord);
        const enabledProviders = loadedProviders.filter((provider) => provider.enabled);
        setProviders(enabledProviders);
        const enabledModels = (modelSettings?.models ?? []).filter((model) => model.enabled);
        setTextModels(enabledModels);
        setOptimizeEnabled(featureSettings?.imageEnabled ?? true);
        setOptimizeModelId(
          (current) => current || featureSettings?.modelId || modelSettings?.effectiveDefaultModelId || enabledModels[0]?.id || ""
        );

        // 初始参数：优先用最近一次批次的请求快照，否则用第一个供应商默认值。
        const lastRun = loadedRecord.runs[loadedRecord.runs.length - 1];
        if (lastRun) {
          setParams({
            providerId: lastRun.request.providerId,
            model: lastRun.request.model,
            prompt: lastRun.request.prompt,
            n: lastRun.request.n ?? 1,
            size: lastRun.request.size ?? "auto",
            quality: lastRun.request.quality ?? "auto"
          });
          setActiveReferenceIds(lastRun.request.referenceImageIds ?? []);
          setSelectedRunId(lastRun.id);
        } else {
          const firstProvider = enabledProviders[0];
          setParams({
            ...DEFAULT_PARAMS,
            providerId: firstProvider?.id ?? "",
            model: firstProvider?.defaultModel ?? ""
          });
          // 无批次的新任务：默认带上任务已有的全部参考图。
          setActiveReferenceIds(loadedRecord.referenceImages.map((image) => image.id));
        }
        paramsInitialized.current = true;
      } catch (bootError) {
        if (!cancelled) {
          setError(bootError instanceof Error ? bootError.message : String(bootError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [client, recordId]);

  const setParam = useCallback<ImageGenDetailState["setParam"]>((key, value) => {
    setParams((current) => ({ ...current, [key]: value }));
  }, []);

  const setProvider = useCallback(
    (providerId: string) => {
      setParams((current) => {
        const provider = providers.find((item) => item.id === providerId);
        return {
          ...current,
          providerId,
          model: provider?.defaultModel || current.model
        };
      });
    },
    [providers]
  );

  const selectRun = useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
      setRecord((current) => {
        const run = current?.runs.find((item) => item.id === runId);
        if (run) {
          setParams({
            providerId: run.request.providerId,
            model: run.request.model,
            prompt: run.request.prompt,
            n: run.request.n ?? 1,
            size: run.request.size ?? "auto",
            quality: run.request.quality ?? "auto"
          });
          // 参考图随批次恢复：该批次用了哪些就显示哪些（可能为空或不同集合）。
          setActiveReferenceIds(run.request.referenceImageIds ?? []);
        }
        return current;
      });
    },
    []
  );

  const generate = useCallback(async () => {
    if (generating) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const request: ImageGenRequest = {
        providerId: params.providerId,
        model: params.model,
        prompt: params.prompt,
        n: params.n,
        size: params.size,
        quality: params.quality,
        referenceImageIds: activeReferenceIds
      };
      const run = await client.generate(recordId, request);
      const refreshed = await client.getRecord(recordId);
      setRecord(refreshed);
      setActiveReferenceIds(run.request.referenceImageIds ?? activeReferenceIds);
      setSelectedRunId(run.id);
      onRecordChanged?.();
      if (run.error) {
        setError(run.error);
      }
    } catch (generateError) {
      if (generateError instanceof ImageGenValidationError) {
        setError(generateError.message);
      } else {
        setError(generateError instanceof Error ? generateError.message : String(generateError));
      }
    } finally {
      setGenerating(false);
    }
  }, [activeReferenceIds, client, generating, onRecordChanged, params, recordId]);

  const optimizePrompt = useCallback(async () => {
    if (optimizing || !params.prompt.trim()) {
      return;
    }
    if (!optimizeModelId) {
      setError("请先在模型提供商配置中启用一个文本模型");
      return;
    }
    setOptimizing(true);
    setError(null);
    try {
      const result = await client.optimizePrompt({ modelId: optimizeModelId, prompt: params.prompt });
      setParams((current) => ({ ...current, prompt: result.prompt }));
    } catch (optimizeError) {
      setError(optimizeError instanceof Error ? optimizeError.message : String(optimizeError));
    } finally {
      setOptimizing(false);
    }
  }, [client, optimizeModelId, optimizing, params.prompt]);

  const uploadReference = useCallback(
    async (file: File) => {
      setUploadingReference(true);
      setError(null);
      try {
        const asset = await client.uploadReference(recordId, file);
        setRecord(await client.getRecord(recordId));
        // 新上传的参考图加入当前工作集，参与下一次生成。
        setActiveReferenceIds((current) => (current.includes(asset.id) ? current : [...current, asset.id]));
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
      } finally {
        setUploadingReference(false);
      }
    },
    [client, recordId]
  );

  // 仅从当前工作集移除，不删除文件：历史批次仍引用该参考图，删文件会破坏历史展示。
  const removeReference = useCallback((imageId: string) => {
    setActiveReferenceIds((current) => current.filter((id) => id !== imageId));
  }, []);

  return {
    record,
    providers,
    textModels,
    params,
    activeReferenceImages: referencesByIds(record, activeReferenceIds),
    selectedRunId: resolveSelectedRun(record, selectedRunId)?.id ?? null,
    optimizeModelId,
    optimizeEnabled,
    loading,
    generating,
    optimizing,
    uploadingReference,
    error,
    setParam,
    setProvider,
    setOptimizeModelId,
    selectRun,
    generate,
    optimizePrompt,
    uploadReference,
    removeReference
  };
}

export { resolveSelectedRun };
