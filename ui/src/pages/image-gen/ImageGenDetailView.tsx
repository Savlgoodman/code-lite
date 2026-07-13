import { useMemo, useRef } from "react";

import { ArrowLeft, ImagePlus, Loader2, Sparkles, Trash2, Wand2 } from "lucide-react";

import { RECOMMENDED_SIZES } from "@code-lite/image-gen";

import { AsyncImage } from "./AsyncImage";
import { resolveSelectedRun, type ImageGenDetailState } from "./useImageGenDetail";
import "./ImageGenDetailPage.css";

const QUALITY_OPTIONS: Array<{ label: string; value: "auto" | "low" | "medium" | "high" }> = [
  { label: "自动", value: "auto" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" }
];

interface ImageGenDetailViewProps {
  state: ImageGenDetailState;
  onBack: () => void;
}

export function ImageGenDetailView({ state, onBack }: ImageGenDetailViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedRun = useMemo(
    () => resolveSelectedRun(state.record, state.selectedRunId),
    [state.record, state.selectedRunId]
  );

  const {
    record,
    providers,
    textModels,
    params,
    optimizeModelId,
    loading,
    generating,
    optimizing,
    uploadingReference,
    error
  } = state;

  const canGenerate = !generating && Boolean(params.providerId) && Boolean(params.model.trim()) && Boolean(params.prompt.trim());

  function handleReferencePick(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }
    for (const file of Array.from(files)) {
      void state.uploadReference(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <section className="imggen-detail">
      <header className="imggen-detail-header">
        <button className="imggen-back-button" onClick={onBack} type="button">
          <ArrowLeft size={16} />
          <span>返回列表</span>
        </button>
        <h2>{record?.title ?? "图片生成"}</h2>
      </header>

      {loading ? (
        <div className="imggen-detail-loading">
          <Loader2 className="imggen-spin" size={20} />
          <span>加载中</span>
        </div>
      ) : (
        <div className="imggen-detail-body">
          <div className="imggen-detail-main">
            <div className="imggen-param-panel">
              <label className="imggen-field imggen-field-prompt">
                <span>提示词</span>
                <textarea
                  onChange={(event) => state.setParam("prompt", event.target.value)}
                  placeholder="描述你想生成的画面"
                  value={params.prompt}
                />
              </label>

              <div className="imggen-optimize-row">
                <select
                  className="imggen-select"
                  onChange={(event) => state.setOptimizeModelId(event.target.value)}
                  value={optimizeModelId}
                >
                  {textModels.length === 0 ? <option value="">无可用文本模型</option> : null}
                  {textModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <button
                  className="imggen-secondary-button"
                  disabled={optimizing || !params.prompt.trim() || !optimizeModelId}
                  onClick={() => void state.optimizePrompt()}
                  type="button"
                >
                  {optimizing ? <Loader2 className="imggen-spin" size={14} /> : <Wand2 size={14} />}
                  <span>优化提示词</span>
                </button>
              </div>

              <label className="imggen-field">
                <span>图片供应商</span>
                <select
                  className="imggen-select"
                  onChange={(event) => state.setProvider(event.target.value)}
                  value={params.providerId}
                >
                  {providers.length === 0 ? <option value="">请先配置供应商</option> : null}
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="imggen-field">
                <span>模型 ID</span>
                <input
                  onChange={(event) => state.setParam("model", event.target.value)}
                  placeholder="gpt-image-2"
                  value={params.model}
                />
              </label>

              <div className="imggen-field-row">
                <label className="imggen-field">
                  <span>分辨率</span>
                  <select
                    className="imggen-select"
                    onChange={(event) => state.setParam("size", event.target.value)}
                    value={params.size}
                  >
                    {RECOMMENDED_SIZES.map((size) => (
                      <option key={size.value} value={size.value}>
                        {size.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="imggen-field">
                  <span>画质</span>
                  <select
                    className="imggen-select"
                    onChange={(event) => state.setParam("quality", event.target.value as typeof params.quality)}
                    value={params.quality}
                  >
                    {QUALITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="imggen-field imggen-field-narrow">
                  <span>数量</span>
                  <input
                    max={4}
                    min={1}
                    onChange={(event) => state.setParam("n", Math.max(1, Math.min(4, Number(event.target.value) || 1)))}
                    type="number"
                    value={params.n}
                  />
                </label>
              </div>

              <button className="imggen-generate-button" disabled={!canGenerate} onClick={() => void state.generate()} type="button">
                {generating ? <Loader2 className="imggen-spin" size={16} /> : <Sparkles size={16} />}
                <span>{generating ? "生成中" : "生成"}</span>
              </button>

              {error ? <div className="imggen-inline-error">{error}</div> : null}
            </div>

            <div className="imggen-canvas-column">
              <div className="imggen-reference-panel">
                <div className="imggen-panel-title">
                  <span>参考图</span>
                  <button
                    className="imggen-secondary-button"
                    disabled={uploadingReference}
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    {uploadingReference ? <Loader2 className="imggen-spin" size={14} /> : <ImagePlus size={14} />}
                    <span>添加</span>
                  </button>
                  <input
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    multiple
                    onChange={(event) => handleReferencePick(event.target.files)}
                    ref={fileInputRef}
                    type="file"
                  />
                </div>
                <div className="imggen-reference-strip">
                  {(record?.referenceImages ?? []).length === 0 ? (
                    <span className="imggen-hint">无参考图，生成走文生图；添加后走图生图。</span>
                  ) : (
                    record?.referenceImages.map((image) => (
                      <div className="imggen-reference-thumb" key={image.id}>
                        <AsyncImage alt="参考图" src={image.url} />
                        <button
                          className="imggen-thumb-delete"
                          onClick={() => void state.deleteReference(image.id)}
                          title="删除参考图"
                          type="button"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="imggen-canvas">
                {generating ? (
                  <div className="imggen-canvas-placeholder">
                    <Loader2 className="imggen-spin" size={24} />
                    <span>正在生成图片</span>
                  </div>
                ) : selectedRun && selectedRun.images.length > 0 ? (
                  <div className="imggen-canvas-grid">
                    {selectedRun.images.map((image) => (
                      <AsyncImage alt="生成图" className="imggen-canvas-image" key={image.id} src={image.url} />
                    ))}
                  </div>
                ) : selectedRun?.error ? (
                  <div className="imggen-canvas-placeholder imggen-canvas-error">{selectedRun.error}</div>
                ) : (
                  <div className="imggen-canvas-placeholder">
                    <Sparkles size={24} />
                    <span>填写提示词后点击生成</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="imggen-history">
            <div className="imggen-history-scroll">
              {(record?.runs ?? []).length === 0 ? (
                <span className="imggen-hint">历史生成会显示在这里，点击可恢复当时的参数与提示词。</span>
              ) : (
                [...(record?.runs ?? [])].reverse().map((run) => (
                  <button
                    className={`imggen-history-item ${run.id === selectedRun?.id ? "active" : ""}`}
                    key={run.id}
                    onClick={() => state.selectRun(run.id)}
                    type="button"
                  >
                    {run.images.length > 0 ? (
                      <AsyncImage alt="历史生成" src={run.images[run.images.length - 1].url} />
                    ) : (
                      <span className="imggen-history-error">失败</span>
                    )}
                    <span className="imggen-history-caption" title={run.request.prompt}>
                      {run.request.prompt || "无提示词"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
