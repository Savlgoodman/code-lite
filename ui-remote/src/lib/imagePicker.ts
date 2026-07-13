import { Camera, EncodingType, MediaTypeSelection, type MediaResult } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { isNativeApp } from "./environment";

const GALLERY_CANCELLED_CODE = "OS-PLUG-CAMR-0020";
const CAMERA_CANCELLED_CODE = "OS-PLUG-CAMR-0006";

function cameraErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function mimeTypeFor(result: MediaResult, blob: Blob): string {
  const format = result.metadata?.format?.toLowerCase();
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  if (blob.type.startsWith("image/")) return blob.type.toLowerCase();
  return format ? `image/${format}` : "application/octet-stream";
}

function extensionFor(mimeType: string, result: MediaResult): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return result.metadata?.format?.toLowerCase() || "image";
}

async function mediaResultToFile(result: MediaResult, index: number, namePrefix: string): Promise<File> {
  const source = result.webPath ?? (result.uri ? Capacitor.convertFileSrc(result.uri) : "");
  if (!source) throw new Error("系统没有返回可读取的图片地址。");

  const response = await fetch(source);
  if (!response.ok) throw new Error("无法读取系统返回的图片。");

  const blob = await response.blob();
  const mimeType = mimeTypeFor(result, blob);
  const extension = extensionFor(mimeType, result);
  return new File([blob], `${namePrefix}-${Date.now()}-${index + 1}.${extension}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

function openWebFileInput(input: HTMLInputElement | null, capture: boolean): void {
  if (!input) throw new Error("找不到图片选择控件。");
  if (capture) input.setAttribute("capture", "environment");
  else input.removeAttribute("capture");
  input.click();
}

function nativePickerError(action: "gallery" | "camera", code: string | null): Error {
  if (code === "OS-PLUG-CAMR-0003") {
    return new Error("无法访问相机，请在系统设置中允许相机权限。");
  }
  if (code === "OS-PLUG-CAMR-0005") {
    return new Error("无法访问系统相册，请检查应用权限。");
  }
  if (code === "OS-PLUG-CAMR-0007") {
    return new Error("当前设备没有可用相机。");
  }
  const actionLabel = action === "camera" ? "拍照" : "打开系统图片选择器";
  return new Error(code ? `${actionLabel}失败（${code}）。` : `${actionLabel}失败。`);
}

/**
 * 原生 App 走系统相册选择器，浏览器环境继续触发现有 file input。
 * 浏览器返回 null，文件由 input 的 change 事件交付；用户取消原生选择时返回空数组。
 */
export async function chooseGalleryImages(
  fallbackInput: HTMLInputElement | null,
  limit: number,
): Promise<File[] | null> {
  if (!isNativeApp()) {
    openWebFileInput(fallbackInput, false);
    return null;
  }

  let results: MediaResult[];
  try {
    const selection = await Camera.chooseFromGallery({
      mediaType: MediaTypeSelection.Photo,
      allowMultipleSelection: true,
      limit,
      includeMetadata: true,
    });
    results = selection.results;
  } catch (error) {
    const code = cameraErrorCode(error);
    if (code === GALLERY_CANCELLED_CODE) return [];
    throw nativePickerError("gallery", code);
  }

  return Promise.all(results.map((result, index) => mediaResultToFile(result, index, "selected-image")));
}

/** 原生 App 调用系统相机；浏览器环境回退到带 capture 的 file input。 */
export async function takeCameraPhoto(fallbackInput: HTMLInputElement | null): Promise<File[] | null> {
  if (!isNativeApp()) {
    openWebFileInput(fallbackInput, true);
    return null;
  }

  let result: MediaResult;
  try {
    result = await Camera.takePhoto({
      quality: 92,
      encodingType: EncodingType.JPEG,
      correctOrientation: true,
      saveToGallery: false,
      editable: "no",
      includeMetadata: true,
    });
  } catch (error) {
    const code = cameraErrorCode(error);
    if (code === CAMERA_CANCELLED_CODE) return [];
    throw nativePickerError("camera", code);
  }

  return [await mediaResultToFile(result, 0, "camera-image")];
}
