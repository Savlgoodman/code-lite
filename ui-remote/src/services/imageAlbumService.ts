import { registerPlugin } from "@capacitor/core";
import { isNativeApp } from "../lib/environment";
import { blobToBase64 } from "./imageBlobStore";

interface ImageAlbumPlugin {
  save(options: { base64: string; mimeType: string; fileName: string }): Promise<{ uri: string }>;
}

const imageAlbum = registerPlugin<ImageAlbumPlugin>("ImageAlbum");

function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/avif") return "avif";
  return "png";
}

function makeFileName(mimeType: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `code-lite-${timestamp}.${extensionFor(mimeType)}`;
}

export async function saveImageToAlbum(blob: Blob): Promise<void> {
  const mimeType = blob.type.startsWith("image/") ? blob.type : "image/png";
  const fileName = makeFileName(mimeType);

  if (isNativeApp()) {
    const encoded = await blobToBase64(blob);
    await imageAlbum.save({ base64: encoded.base64, mimeType, fileName });
    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
