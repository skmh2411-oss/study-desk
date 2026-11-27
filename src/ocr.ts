import type { Worker as OCRWorker } from "tesseract.js";

export interface OCRResult {
  name: string;
  text: string;
}
export interface OCROptions {
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_EDGE = 3200;
const MAX_IMAGE_PIXELS = 8_000_000;
let running = false;
function aborted() {
  return new DOMException("OCRをキャンセルしました。", "AbortError");
}
function checkFiles(files: File[]) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES)
    throw new Error("画像は1〜5枚で選択してください。");
  for (const file of files) {
    if (!(file instanceof File) || !file.size || file.size > MAX_BYTES)
      throw new Error("画像は1枚あたり10MB以下にしてください。");
    if (
      file.type === "image/svg+xml" ||
      /\.svgz?$/i.test(file.name) ||
      (!file.type.startsWith("image/") &&
        !/\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif|avif)$/i.test(file.name))
    )
      throw new Error("画像ファイルを選択してください。SVG・PDFは対象外です。");
  }
}
/** Browser-decode to a bounded PNG: correct orientation, no source URL or persisted image. */
async function imageBytes(file: File, ensureActive: () => void): Promise<Blob> {
  let bitmap: ImageBitmap | undefined;
  let source: CanvasImageSource;
  let width: number, height: number;
  if (typeof createImageBitmap === "function") {
    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
    } catch {
      throw new Error(
        `${file.name}を画像として開けません。JPEG/PNGの画像やスクリーンショットを使用してください。`,
      );
    }
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } else {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("画像を読み込めません。"));
      reader.readAsDataURL(file);
    });
    ensureActive();
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(
          new Error(
            `${file.name}を開けません。JPEG/PNGで再度選択してください。`,
          ),
        );
      image.src = data;
    });
    source = image;
    width = image.naturalWidth;
    height = image.naturalHeight;
  }
  try {
    ensureActive();
    if (!width || !height) throw new Error("画像の大きさが不正です。");
    const ratio = Math.min(
      1,
      MAX_IMAGE_EDGE / width,
      MAX_IMAGE_EDGE / height,
      Math.sqrt(MAX_IMAGE_PIXELS / (width * height)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("このブラウザでは画像を処理できません。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("画像を変換できません。"))),
        "image/png",
      ),
    );
    canvas.width = 0;
    canvas.height = 0;
    ensureActive();
    return blob;
  } finally {
    bitmap?.close();
  }
}
/**
 * Official Tesseract public API, portable LSTM core, self-hosted Japanese + English.
 * No image is stored or uploaded. During createWorker initialization the public API
 * does not expose a worker handle: abort returns immediately and termination follows
 * as soon as initialization completes. No images are passed before it completes.
 */
export async function recognizeImages(
  files: File[],
  { onProgress, signal }: OCROptions,
): Promise<OCRResult[]> {
  checkFiles(files);
  if (signal?.aborted) throw aborted();
  if (running)
    throw new Error(
      "ほかのOCR処理が実行中です。完了またはキャンセル後に再度お試しください。",
    );
  running = true;
  let worker: OCRWorker | undefined;
  let closed = false,
    terminated = false,
    initializing = false;
  let rejectAbort: (reason: unknown) => void = () => {};
  let rejectInit: (reason: unknown) => void = () => {};
  let imageIndex = 0;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const initError = new Promise<never>((_, reject) => {
    rejectInit = reject;
  });
  // Both race promises have handlers attached immediately, including early aborts.
  void abortPromise.catch(() => {});
  void initError.catch(() => {});
  const terminate = async () => {
    if (worker && !terminated) {
      terminated = true;
      await worker.terminate();
    }
  };
  const ensureActive = () => {
    if (closed || signal?.aborted) throw aborted();
  };
  const onAbort = () => {
    closed = true;
    void terminate().catch(() => {});
    rejectAbort(aborted());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = window.setTimeout(() => {
    closed = true;
    void terminate().catch(() => {});
    rejectInit(
      new Error(
        "OCRの準備に時間がかかっています。接続状態を確認し、アプリを開き直してください。",
      ),
    );
  }, 120_000);
  try {
    onProgress("端末内OCRを準備しています（画像の外部送信なし）");
    const { createWorker, OEM } = await import("tesseract.js");
    ensureActive();
    const root = new URL(import.meta.env.BASE_URL, document.baseURI);
    const assets = new URL("ocr/", root);
    initializing = true;
    const initialization = createWorker(["jpn", "eng"], OEM.LSTM_ONLY, {
      workerPath: new URL("worker.min.js", assets).href,
      corePath: new URL("tesseract-core-lstm.js", assets).href,
      langPath: assets.href.replace(/\/$/, ""),
      workerBlobURL: false,
      gzip: true,
      // Workbox owns the immutable language cache. No separate OCR IndexedDB store.
      cacheMethod: "none",
      logger: (message) => {
        if (closed || signal?.aborted) return;
        const progress = Number.isFinite(message.progress)
          ? Math.round(message.progress * 100)
          : 0;
        onProgress(
          imageIndex
            ? `${imageIndex}/${files.length}枚目を読み取り中 · ${progress}%`
            : `OCRを準備中 · ${progress}%`,
        );
      },
      errorHandler: (error) =>
        rejectInit(
          new Error(
            `OCRを開始できません。初回はオンラインでアプリの読み込みを完了してください。${String(error).slice(0, 160)}`,
          ),
        ),
    });
    void initialization
      .then(async (ready) => {
        worker = ready;
        if (closed || signal?.aborted) await terminate();
      })
      .catch(() => {})
      .finally(() => {
        initializing = false;
        if (closed) running = false;
      });
    worker = await Promise.race([initialization, abortPromise, initError]);
    window.clearTimeout(timer);
    ensureActive();
    await Promise.race([
      worker.setParameters({ preserve_interword_spaces: "1" }),
      abortPromise,
      initError,
    ]);
    const results: OCRResult[] = [];
    for (let i = 0; i < files.length; i++) {
      ensureActive();
      imageIndex = i + 1;
      onProgress(`${imageIndex}/${files.length}枚目の画像を準備中`);
      const bytes = await Promise.race([
        imageBytes(files[i], ensureActive),
        abortPromise,
      ]);
      ensureActive();
      const result = await Promise.race([
        worker.recognize(
          new File([bytes], "ocr.png", { type: "image/png" }),
          {},
          { text: true },
        ),
        abortPromise,
        initError,
      ]);
      ensureActive();
      results.push({ name: files[i].name, text: result.data.text.trim() });
    }
    onProgress(
      `${files.length}枚の読み取りが完了しました。誤読を確認してから取り込んでください。`,
    );
    return results;
  } finally {
    closed = true;
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await terminate().catch(() => {});
    if (!initializing) running = false;
  }
}
