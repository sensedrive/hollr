// Files for the agent (Attachments.swift): big images are scaled down to JPEG first, then everything
// goes to the server as base64 (`hollr gate upload`); the agent gets the absolute path.
import { upload } from "./api";
import { fitSize, JPEG_QUALITY, jpegName, UPLOAD_LIMIT } from "./assist";
import { t } from "./i18n";

/** images above this are re-encoded even when small enough in pixels */
const REENCODE_BYTES = 2 * 1024 * 1024;

/** Scales a big photo / screenshot down (longer side ≤ 2048 px, JPEG 0.8); other files stay as they are. */
export async function shrink(file: File): Promise<{ name: string; blob: Blob }> {
  const plain = { name: file.name || "datei", blob: file as Blob };
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return plain;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return plain; // a format the webview can't decode (HEIC …): send the original
  }
  const size = fitSize(bitmap.width, bitmap.height);
  if (!size.scaled && file.size <= REENCODE_BYTES) {
    bitmap.close();
    return plain;
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return plain;
  }
  // JPEG has no alpha: transparent screenshots get a white background instead of black
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", JPEG_QUALITY));
  return blob && blob.size < file.size ? { name: jpegName(file.name), blob } : plain;
}

function base64(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const reader = new FileReader();
    reader.onload = () => ok(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => fail(reader.error ?? new Error("read"));
    reader.readAsDataURL(blob);
  });
}

/** Uploads one file; returns its absolute path on the server. */
export async function attach(server: string, file: File): Promise<string> {
  const { name, blob } = await shrink(file);
  if (blob.size > UPLOAD_LIMIT) throw new Error(t("{name} ist zu groß (höchstens 20 MB).", { name }));
  try {
    return await upload(server, name, await base64(blob));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg === "too_large" ? t("{name} ist zu groß (höchstens 20 MB).", { name }) : msg);
  }
}
