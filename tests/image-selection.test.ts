import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeSelectedImage,
  MAX_IMAGE_BYTES,
  mergeSelectedImages,
  validateSelectedImages,
} from "../src/imageSelection";
const photo = (name = "image.jpg", type = "image/jpeg", content = "data") =>
  new File([content], name, { type, lastModified: 1 });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selected images stay in the local workspace", () => {
  it("appends selected files and leaves the previous selection intact on cancel", () => {
    const first = photo(),
      second = photo("screenshot.png", "image/png");
    const original = [first];
    expect(mergeSelectedImages(original, [])).toBe(original);
    expect(mergeSelectedImages(original, [second])).toEqual([first, second]);
    expect(original).toEqual([first]);
  });
  it("does not append the same selected file twice", () => {
    const first = photo();
    expect(mergeSelectedImages([first], [photo()])).toEqual([first]);
  });
  it("rejects a batch exceeding the total count without dropping existing files", () => {
    const original = Array.from({ length: 5 }, (_, i) => photo(`${i}.jpg`));
    expect(() => mergeSelectedImages(original, [photo("extra.jpg")])).toThrow(
      "合わせて5枚",
    );
    expect(original).toHaveLength(5);
    expect(mergeSelectedImages(original, [original[0]])).toHaveLength(5);
  });
  it("accepts HEIC, extension-only files and upper-case extensions for browser decoding", () => {
    expect(() =>
      validateSelectedImages([
        photo("IMG.HEIC", ""),
        photo("photo.heif", "image/heif"),
        photo("screen.PNG", "application/octet-stream"),
      ]),
    ).not.toThrow();
  });
  it("rejects SVG, PDF and documents from the unrestricted file picker", () => {
    for (const file of [
      photo("bad.svg", "image/png"),
      photo("bad.png", "image/svg+xml"),
      photo("document.pdf", "application/pdf"),
      photo("text.txt", "text/plain"),
    ])
      expect(() => mergeSelectedImages([photo()], [file])).toThrow(
        "画像を選択",
      );
  });
  it("rejects empty and oversized files before image processing", () => {
    expect(() =>
      validateSelectedImages([photo("empty.jpg", "image/jpeg", "")]),
    ).toThrow("10MB");
    const large = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "large.jpg", {
      type: "image/jpeg",
    });
    expect(() => validateSelectedImages([large])).toThrow("10MB");
  });
});

describe("browser image decoding and resource cleanup", () => {
  function fallbackImage(fails = false) {
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 120;
        naturalHeight = 80;
        onload?: () => void;
        onerror?: () => void;
        set src(_url: string) {
          queueMicrotask(() => (fails ? this.onerror?.() : this.onload?.()));
        }
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "blob:local-selected-image",
    );
    return vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  }
  it("falls back to the image decoder if createImageBitmap rejects HEIC", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockRejectedValue(new Error("Unsupported bitmap")),
    );
    const revoke = fallbackImage();
    const decoded = await decodeSelectedImage(
      photo("photo.heic", "image/heic"),
      () => {},
    );
    expect(decoded.width).toBe(120);
    expect(decoded.height).toBe(80);
    expect(revoke).not.toHaveBeenCalled();
    decoded.close();
    expect(revoke).toHaveBeenCalledWith("blob:local-selected-image");
  });
  it("reports unsupported formats and releases the temporary URL", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const revoke = fallbackImage(true);
    await expect(
      decodeSelectedImage(photo("bad.heic", "image/heic"), () => {}),
    ).rejects.toThrow("JPEG/PNG");
    expect(revoke).toHaveBeenCalledOnce();
  });
  it("closes a bitmap if cancellation arrives while it decodes", async () => {
    let active = true;
    const bitmap = { width: 10, height: 10, close: vi.fn() };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        active = false;
        return bitmap;
      }),
    );
    await expect(
      decodeSelectedImage(photo(), () => {
        if (!active) throw new DOMException("Cancelled", "AbortError");
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
