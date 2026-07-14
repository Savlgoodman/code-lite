import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Check, ImagePlus, Loader2, Sparkles, Square, Wand2, X } from "lucide-react";
import { RECOMMENDED_SIZES } from "@code-lite/image-gen";
import { Portal, Select, TextArea } from "../components/ui";
import { BlobImage } from "../components/BlobImage";
import { useDismissable } from "../hooks/useDismissable";
import { useImageProviders } from "../hooks/useImageProviders";
import { useAiProviders } from "../hooks/useAiProviders";
import { imageGenStore, type ImageRun, type ImageRunParams } from "../services/ImageGenStore";
import { addReferenceImage, optimizePrompt, startGeneration, imageGenTasks } from "../services/imageGenService";
import { imageBlobStore } from "../services/imageBlobStore";
import { IMAGE_ACCEPT } from "../lib/draftImages";

interface ImageGenPageProps {
  recordId: string;
  onBack: () => void;
}

type Quality = ImageRunParams["quality"];

const QUALITY_OPTIONS = [
  { value: "auto", label: "画质自动" },
  { value: "low", label: "画质低" },
  { value: "medium", label: "画质中" },
  { value: "high", label: "画质高" },
];

const N_OPTIONS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} 张` }));

export function ImageGenPage({ recordId, onBack }: ImageGenPageProps) {
  const { providers } = useImageProviders();
  const { models: textModels } = useAiProviders();
  const [runs, setRuns] = useState<ImageRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState<Quality>("auto");
  const [n, setN] = useState(1);
  const [optimizeModelId, setOptimizeModelId] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fitToView, setFitToView] = useState(false);
  const [justAddedRef, setJustAddedRef] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // 进行中状态来自 service 单例（跨页面存活）：退出页面再进来仍能看到"生成中"。
  const activeRecords = useSyncExternalStore(imageGenTasks.subscribe, imageGenTasks.getActiveSnapshot);
  const generating = activeRecords.includes(recordId);
  const wasGeneratingRef = useRef(generating);

  useDismissable(preview !== null, () => setPreview(null));

  // 生成结束（generating 由 true 变 false）时刷新批次列表，并读取可能的错误。
  useEffect(() => {
    if (wasGeneratingRef.current && !generating) {
      const genErr = imageGenTasks.getError(recordId);
      if (genErr) {
        setError(genErr);
        imageGenTasks.clearError(recordId);
      }
      void (async () => {
        const loaded = await imageGenStore.loadRuns(recordId);
        setRuns(loaded);
        const last = loaded[loaded.length - 1];
        if (last) setSelectedRunId(last.id);
      })();
    }
    wasGeneratingRef.current = generating;
  }, [generating, recordId]);

  // 输入框随文字增高，最高约 5 行（超出则自身滚动，不挤压图片区）。
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 128) + "px";
  }, [prompt]);

  // 载入任务批次；初始参数取最近一次批次快照，否则取首个供应商默认值。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await imageGenStore.init();
      const loaded = await imageGenStore.loadRuns(recordId);
      if (cancelled) return;
      setRuns(loaded);
      const last = loaded[loaded.length - 1];
      if (last) {
        applyParams(last.params);
        setSelectedRunId(last.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]);

  // 供应商加载后，若尚未选择则用第一个及其默认模型。
  useEffect(() => {
    if (!providerId && providers.length > 0) {
      setProviderId(providers[0].id);
      if (!model) setModel(providers[0].defaultModel);
    }
  }, [providers, providerId, model]);

  useEffect(() => {
    if (!optimizeModelId && textModels.length > 0) setOptimizeModelId(textModels[0].id);
  }, [textModels, optimizeModelId]);

  function applyParams(params: ImageRunParams) {
    setPrompt(params.prompt);
    setProviderId(params.providerId);
    setModel(params.model);
    setSize(params.size);
    setQuality(params.quality);
    setN(params.n);
    setReferenceIds(params.referenceImageIds);
  }

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? runs[runs.length - 1] ?? null,
    [runs, selectedRunId],
  );

  const providerOptions = providers.map((p) => ({ value: p.id, label: p.name }));
  const canGenerate = Boolean(providerId) && Boolean(model.trim()) && Boolean(prompt.trim());

  async function handleAddReference(files: FileList | null) {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    for (const file of list) {
      const ref = await addReferenceImage(recordId, file);
      setReferenceIds((prev) => [...prev, ref.id]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeReference(imageId: string) {
    setReferenceIds((prev) => prev.filter((id) => id !== imageId));
  }

  // 把生成图快速加入参考图池：取其 Blob 登记为独立参考图（新 id，与生成图解耦），
  // 并加入当前批次的参考图列表。短暂标记"已添加"给出反馈。
  async function addGeneratedAsReference(imageId: string) {
    const blob = await imageBlobStore.getImage(imageId);
    if (!blob) return;
    const ref = await addReferenceImage(recordId, blob);
    setReferenceIds((prev) => (prev.includes(ref.id) ? prev : [...prev, ref.id]));
    setJustAddedRef(imageId);
    setTimeout(() => setJustAddedRef((cur) => (cur === imageId ? null : cur)), 1500);
  }

  async function previewImage(imageId: string) {
    const blob = await imageBlobStore.getImage(imageId);
    if (blob) setPreview(URL.createObjectURL(blob));
  }

  async function handleOptimize() {
    if (optimizing || !prompt.trim() || !optimizeModelId) return;
    setOptimizing(true);
    setError(null);
    try {
      setPrompt(await optimizePrompt(optimizeModelId, prompt));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOptimizing(false);
    }
  }

  function handleGenerate() {
    if (generating) {
      imageGenTasks.cancel(recordId);
      return;
    }
    if (!canGenerate) return;
    setError(null);
    const params: ImageRunParams = {
      providerId,
      model: model.trim(),
      prompt: prompt.trim(),
      n,
      size,
      quality,
      referenceImageIds: referenceIds,
    };
    // fire-and-forget：进行中状态由 imageGenTasks 单例追踪，退出页面仍继续；
    // 完成后经上面的 useEffect 刷新批次列表。
    startGeneration(recordId, params);
  }

  function selectRun(run: ImageRun) {
    setSelectedRunId(run.id);
    applyParams(run.params);
  }

  return (
    <div className="imggen-page">
      <header className="chat-header">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={24} />
        </button>
        <h1 className="chat-title">图片生成</h1>
        <label className="imggen-fit-toggle">
          <input type="checkbox" checked={fitToView} onChange={(e) => setFitToView(e.target.checked)} />
          <span>全貌</span>
        </label>
      </header>

      <div className="imggen-scroll">
        {referenceIds.length > 0 && (
          <div className="imggen-ref-strip">
            {referenceIds.map((id) => (
              <div className="imggen-ref-thumb" key={id}>
                <BlobImage imageId={id} alt="参考图" onClick={() => void previewImage(id)} />
                <button className="imggen-ref-remove" onClick={() => removeReference(id)} aria-label="移除参考图">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="imggen-canvas">
          {generating ? (
            <div className="imggen-canvas-hint">
              <Loader2 className="imggen-spin" size={26} />
              <span>正在生成…</span>
            </div>
          ) : selectedRun && selectedRun.imageIds.length > 0 ? (
            <div className={`imggen-canvas-grid${fitToView ? " fit-to-view" : ""}`}>
              {selectedRun.imageIds.map((id) => (
                <div className="imggen-canvas-item" key={id}>
                  <BlobImage imageId={id} alt="生成图" className="imggen-canvas-img" onClick={() => void previewImage(id)} />
                  <button
                    className="imggen-add-ref-btn"
                    onClick={(e) => { e.stopPropagation(); void addGeneratedAsReference(id); }}
                    aria-label="加入参考图"
                    title="加入参考图"
                  >
                    {justAddedRef === id ? <Check size={15} /> : <ImagePlus size={15} />}
                  </button>
                </div>
              ))}
            </div>
          ) : selectedRun?.error ? (
            <div className="imggen-canvas-hint error">{selectedRun.error}</div>
          ) : (
            <div className="imggen-canvas-hint">
              <Sparkles size={26} />
              <span>填写提示词后点击生成</span>
            </div>
          )}
        </div>

        {runs.length > 0 && (
          <div className="imggen-history">
            {[...runs].reverse().map((run) => (
              <button
                key={run.id}
                className={`imggen-history-item${run.id === selectedRun?.id ? " active" : ""}`}
                onClick={() => selectRun(run)}
              >
                {run.imageIds.length > 0 ? (
                  <BlobImage imageId={run.imageIds[run.imageIds.length - 1]} alt="历史" />
                ) : (
                  <span className="imggen-history-fail">失败</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="imggen-controls">
        {error && <div className="draft-image-error">{error}</div>}
        <TextArea
          ref={promptRef}
          className="imggen-prompt"
          placeholder="描述你想生成的画面…"
          value={prompt}
          onValueChange={setPrompt}
        />
        <div className="imggen-optimize-row">
          <Select
            value={optimizeModelId}
            onChange={setOptimizeModelId}
            options={textModels.length > 0 ? textModels.map((m) => ({ value: m.id, label: m.label })) : [{ value: "", label: "无文本模型" }]}
          />
          <button className="imggen-btn-ghost" disabled={optimizing || !prompt.trim() || !optimizeModelId} onClick={() => void handleOptimize()}>
            {optimizing ? <Loader2 className="imggen-spin" size={15} /> : <Wand2 size={15} />}
            <span>优化</span>
          </button>
        </div>
        <div className="imggen-param-grid">
          <Select value={providerId} onChange={(v) => { setProviderId(v); const p = providers.find((x) => x.id === v); if (p) setModel(p.defaultModel); }} options={providerOptions.length > 0 ? providerOptions : [{ value: "", label: "无供应商" }]} />
          <Select value={size} onChange={setSize} options={RECOMMENDED_SIZES} />
          <Select value={quality} onChange={(v) => setQuality(v as Quality)} options={QUALITY_OPTIONS} />
          <Select value={String(n)} onChange={(v) => setN(Number(v) || 1)} options={N_OPTIONS} />
        </div>
        <div className="imggen-action-row">
          <button className="imggen-btn-ghost" onClick={() => fileInputRef.current?.click()} aria-label="添加参考图">
            <ImagePlus size={16} />
            <span>参考图</span>
          </button>
          <button
            className={`imggen-btn-primary${generating ? " cancel" : ""}`}
            disabled={!generating && !canGenerate}
            onClick={handleGenerate}
          >
            {generating ? <Square size={16} /> : <Sparkles size={16} />}
            <span>{generating ? "终止" : "生成"}</span>
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={(e) => void handleAddReference(e.currentTarget.files)} />
      </footer>

      {preview && (
        <Portal>
          <div className="image-preview-overlay" onClick={() => setPreview(null)}>
            <button className="image-preview-close" aria-label="关闭预览" onClick={() => setPreview(null)}>
              <X size={22} />
            </button>
            <img className="image-preview-full" src={preview} alt="预览" onClick={(e) => e.stopPropagation()} />
          </div>
        </Portal>
      )}
    </div>
  );
}
