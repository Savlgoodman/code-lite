/**
 * ImageGenStore — 生图任务与批次记录持久化（远程端本地）
 *
 * 与 AiConversationStore 同构：
 * - 索引键 `image-records` 存任务元数据列表（不含 runs）。
 * - 每个任务的 runs 单独存 `image-record-runs-{id}`。
 * - 图片二进制在 imageBlobStore（IndexedDB）；删除任务时级联删除其 runs 与图片。
 *
 * 提供 useSyncExternalStore 所需 subscribe/getSnapshot（快照为任务元数据列表）。
 */

import { Preferences } from "@capacitor/preferences";
import { imageBlobStore } from "./imageBlobStore";

const RECORDS_KEY = "image-records";
const RUNS_KEY_PREFIX = "image-record-runs-";
const TITLE_MAX_CHARS = 24;

/** 一张图片的引用（二进制在 IndexedDB，这里只存 id 与元数据）。 */
export interface ImageRef {
  id: string;
  mimeType: string;
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

/** 一次生成的参数快照。 */
export interface ImageRunParams {
  providerId: string;
  model: string;
  prompt: string;
  n: number;
  size: string;
  quality: "auto" | "low" | "medium" | "high";
  /** 该批次使用的参考图 id（指向 IndexedDB）。 */
  referenceImageIds: string[];
}

/** 一次生成批次。 */
export interface ImageRun {
  id: string;
  createdAt: number;
  params: ImageRunParams;
  imageIds: string[];
  images: ImageRef[];
  error?: string;
}

/** 任务元数据（列表页用，不含 runs）。 */
export interface ImageRecordMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  coverImageId: string | null;
  runCount: number;
  /** 任务级参考图池（所有上传过的参考图，按批次 referenceImageIds 引用其子集）。 */
  referenceImages: ImageRef[];
}

function titleFromPrompt(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, TITLE_MAX_CHARS) : "未命名生成";
}

async function readJson<T>(key: string): Promise<T | null> {
  const pref = await Preferences.get({ key });
  const raw = pref.value ?? localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await Preferences.set({ key, value: json });
  localStorage.setItem(key, json);
}

async function removeKey(key: string): Promise<void> {
  await Preferences.remove({ key });
  localStorage.removeItem(key);
}

export class ImageGenStore {
  private records: ImageRecordMeta[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ImageRecordMeta[] => this.records;

  private emit(): void {
    for (const l of this.listeners) l();
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.records = (await readJson<ImageRecordMeta[]>(RECORDS_KEY)) ?? [];
    this.loaded = true;
    this.emit();
  }

  private async persistRecords(): Promise<void> {
    await writeJson(RECORDS_KEY, this.records);
    this.emit();
  }

  getRecordMeta(id: string): ImageRecordMeta | undefined {
    return this.records.find((r) => r.id === id);
  }

  async createRecord(): Promise<ImageRecordMeta> {
    const now = Date.now();
    const record: ImageRecordMeta = {
      id: crypto.randomUUID(),
      title: "未命名生成",
      createdAt: now,
      updatedAt: now,
      coverImageId: null,
      runCount: 0,
      referenceImages: [],
    };
    this.records = [record, ...this.records];
    await this.persistRecords();
    return record;
  }

  async deleteRecord(id: string): Promise<void> {
    const runs = await this.loadRuns(id);
    const meta = this.getRecordMeta(id);
    // 级联删除该任务所有图片二进制（生成图 + 参考图）。
    const imageIds = new Set<string>();
    for (const run of runs) for (const imgId of run.imageIds) imageIds.add(imgId);
    for (const ref of meta?.referenceImages ?? []) imageIds.add(ref.id);
    await imageBlobStore.deleteMany([...imageIds]);
    await removeKey(RUNS_KEY_PREFIX + id);
    this.records = this.records.filter((r) => r.id !== id);
    await this.persistRecords();
  }

  // ── 批次 ──

  async loadRuns(recordId: string): Promise<ImageRun[]> {
    return (await readJson<ImageRun[]>(RUNS_KEY_PREFIX + recordId)) ?? [];
  }

  private async saveRuns(recordId: string, runs: ImageRun[]): Promise<void> {
    await writeJson(RUNS_KEY_PREFIX + recordId, runs);
  }

  /** 追加一次生成批次，更新任务标题 / 封面 / 计数 / updatedAt。 */
  async appendRun(recordId: string, run: ImageRun): Promise<void> {
    const runs = await this.loadRuns(recordId);
    runs.push(run);
    await this.saveRuns(recordId, runs);
    const cover = run.imageIds.length > 0 ? run.imageIds[run.imageIds.length - 1] : null;
    this.records = this.records.map((r) => {
      if (r.id !== recordId) return r;
      return {
        ...r,
        title: run.params.prompt.trim() ? titleFromPrompt(run.params.prompt) : r.title,
        coverImageId: cover ?? r.coverImageId,
        runCount: runs.length,
        updatedAt: Date.now(),
      };
    });
    await this.persistRecords();
  }

  // ── 参考图池 ──

  /** 向任务参考图池加入一张参考图（二进制已存 IndexedDB，这里登记引用）。 */
  async addReference(recordId: string, ref: ImageRef): Promise<void> {
    this.records = this.records.map((r) =>
      r.id === recordId ? { ...r, referenceImages: [...r.referenceImages, ref], updatedAt: Date.now() } : r,
    );
    await this.persistRecords();
  }
}

export const imageGenStore = new ImageGenStore();
