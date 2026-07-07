export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
export const MAX_DRAFT_IMAGES = 20;
export const MAX_IMAGE_BYTES = 10 * 1000 * 1000;
export const MAX_TOTAL_IMAGE_BYTES = 200 * 1000 * 1000;
export const MAX_RAW_IMAGE_BYTES = 50 * 1000 * 1000;
export const MAX_IMAGE_DIMENSION = 2000;

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface NormalizedDraftImage {
  blob: Blob;
  height: number;
  mimeType: SupportedImageMimeType;
  normalizedBytes: number;
  wasCompressed: boolean;
  width: number;
}

export interface DraftImage {
  error?: string;
  file: File;
  height?: number;
  id: string;
  mimeType: SupportedImageMimeType;
  name: string;
  normalized?: NormalizedDraftImage;
  objectUrl: string;
  rawBytes: number;
  width?: number;
}

const SUPPORTED_MIME_TYPES = new Set<string>(IMAGE_ACCEPT.split(","));

function createId(prefix: string) {
  if (crypto.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSupportedMimeType(value: string): value is SupportedImageMimeType {
  return SUPPORTED_MIME_TYPES.has(value);
}

function extensionForMime(mimeType: SupportedImageMimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function outputName(inputName: string, mimeType: SupportedImageMimeType) {
  const base = inputName.replace(/\.[^.]*$/, "") || "image";
  return `${base}.${extensionForMime(mimeType)}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: SupportedImageMimeType, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("图片压缩失败。"));
    }, mimeType, quality);
  });
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

function scaledSize(width: number, height: number, maxDimension: number) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

async function encodeImage(
  bitmap: ImageBitmap,
  maxDimension: number,
  mimeType: SupportedImageMimeType,
  quality?: number,
) {
  const { width, height } = scaledSize(bitmap.width, bitmap.height, maxDimension);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("浏览器无法创建图片压缩画布。");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, mimeType, quality);
  return { blob, width, height };
}

async function normalizeImage(file: File, mimeType: SupportedImageMimeType): Promise<NormalizedDraftImage> {
  const bitmap = await decodeImage(file);
  try {
    const dimensionsFit = Math.max(bitmap.width, bitmap.height) <= MAX_IMAGE_DIMENSION;
    if (dimensionsFit && file.size <= MAX_IMAGE_BYTES) {
      return {
        blob: file,
        height: bitmap.height,
        mimeType,
        normalizedBytes: file.size,
        wasCompressed: false,
        width: bitmap.width,
      };
    }

    const attempts: Array<{ max: number; mime: SupportedImageMimeType; quality?: number }> = [
      ...(mimeType === "image/png"
        ? [{ max: MAX_IMAGE_DIMENSION, mime: "image/png" as const }]
        : []),
      { max: MAX_IMAGE_DIMENSION, mime: mimeType === "image/webp" ? "image/webp" : "image/jpeg", quality: 0.86 },
      { max: MAX_IMAGE_DIMENSION, mime: "image/jpeg", quality: 0.78 },
      { max: 1600, mime: "image/jpeg", quality: 0.76 },
      { max: 1280, mime: "image/jpeg", quality: 0.72 },
    ];

    for (const attempt of attempts) {
      const encoded = await encodeImage(bitmap, attempt.max, attempt.mime, attempt.quality);
      if (encoded.blob.size <= MAX_IMAGE_BYTES) {
        return {
          blob: encoded.blob,
          height: encoded.height,
          mimeType: attempt.mime,
          normalizedBytes: encoded.blob.size,
          wasCompressed: true,
          width: encoded.width,
        };
      }
    }
  } finally {
    bitmap.close();
  }

  throw new Error("图片过大，压缩后仍超过 10 MB。");
}

export async function createDraftImage(file: File): Promise<DraftImage> {
  const mimeType = file.type.toLowerCase();
  if (!isSupportedMimeType(mimeType)) {
    throw new Error("仅支持 PNG、JPEG、WEBP 图片。");
  }
  if (file.size > MAX_RAW_IMAGE_BYTES) {
    throw new Error("图片原始文件超过 50 MB，无法导入。");
  }

  const normalized = await normalizeImage(file, mimeType);
  const objectUrl = URL.createObjectURL(normalized.blob);
  return {
    file,
    height: normalized.height,
    id: createId("draft-image"),
    mimeType: normalized.mimeType,
    name: outputName(file.name || "image", normalized.mimeType),
    normalized,
    objectUrl,
    rawBytes: file.size,
    width: normalized.width,
  };
}

export function revokeDraftImage(image: DraftImage) {
  URL.revokeObjectURL(image.objectUrl);
}
