/** Only user-selected raster images enter the OCR workspace; no folder access. */
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function validateSelectedImages(files: File[]) {
  if (!files.length || files.length > MAX_IMAGES)
    throw new Error("画像は1〜5枚で選択してください。");
  for (const file of files) {
    if (!file.size || file.size > MAX_IMAGE_BYTES)
      throw new Error(`${file.name}：画像は1枚あたり10MB以下にしてください。`);
    if (
      /\.(svgz?|pdf)$/i.test(file.name) ||
      ["image/svg+xml", "application/pdf"].includes(file.type.toLowerCase()) ||
      (!/^image\//i.test(file.type) &&
        !/\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif|avif)$/i.test(file.name))
    )
      throw new Error(
        `${file.name}：画像を選択してください。SVG・PDF・文書は対象外です。`,
      );
  }
}
/** Cancel/duplicates keep the current selection. An invalid batch changes nothing. */
export function mergeSelectedImages(current: File[], incoming: File[]) {
  if (!incoming.length) return current;
  validateSelectedImages(incoming);
  const key = (f: File) =>
    JSON.stringify([f.name, f.size, f.lastModified, f.type]);
  const keys = new Set(current.map(key));
  const next = [...current];
  for (const file of incoming) {
    if (!keys.has(key(file))) {
      next.push(file);
      keys.add(key(file));
    }
  }
  if (next.length > MAX_IMAGES)
    throw new Error(
      "選択済みの画像と合わせて5枚までです。不要な画像を外してから追加してください。",
    );
  return next;
}

export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}
/** Some Safari formats decode with <img> even if createImageBitmap rejects them. */
export async function decodeSelectedImage(
  file: File,
  ensureActive: () => void,
): Promise<DecodedImage> {
  ensureActive();
  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
    } catch {
      // Try the browser's image decoder before treating HEIC etc. as unsupported.
    }
    if (bitmap) {
      try {
        ensureActive();
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap!.close(),
        };
      } catch (error) {
        bitmap.close();
        throw error;
      }
    }
  }
  ensureActive();
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(
          new Error(
            `${file.name}：この端末では画像を開けません。HEICなどの場合は写真ライブラリから選び直すか、JPEG/PNG・スクリーンショットを使用してください。`,
          ),
        );
      image.src = url;
    });
    ensureActive();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
