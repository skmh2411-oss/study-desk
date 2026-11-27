/** One optional, explicitly approved HTTPS sync origin; no wildcard endpoints. */
export function normalizeSupabaseOrigin(value: string | undefined): string {
  if (!value?.trim()) return "";
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("同期先はSupabaseのHTTPS Project URLで指定してください。");
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    /[\s'"<>;]/.test(raw)
  ) {
    throw new Error(
      "同期先は https://プロジェクトID.supabase.co の形式で指定してください。",
    );
  }
  return url.origin;
}
export function allowedSyncOrigin(): string {
  return normalizeSupabaseOrigin(import.meta.env.VITE_SUPABASE_ORIGIN);
}
export function assertApprovedSyncOrigin(value: string): void {
  const approved = allowedSyncOrigin();
  if (!approved)
    throw new Error(
      "この版は端末内保存専用です。同期するには、公開前にVITE_SUPABASE_ORIGINで本人のProject URLを指定して再ビルドしてください。",
    );
  if (normalizeSupabaseOrigin(value) !== approved)
    throw new Error(
      "このアプリで許可された同期先と一致しません。設定手順を確認してください。",
    );
}
/** GitHub Pages compatible meta CSP. Header-only directives are documented separately. */
export function buildCsp(origin = "", development = false): string {
  const approved = normalizeSupabaseOrigin(origin);
  return [
    "default-src 'none'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ""}`,
    "script-src-attr 'none'",
    // KaTeX and React set style attributes; inline JavaScript stays forbidden.
    "style-src 'self' 'unsafe-inline'",
    `style-src-elem 'self'${development ? " 'unsafe-inline'" : ""}`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src 'self'${approved ? " " + approved : ""}${development ? " ws: wss:" : ""}`,
    // OCR uses a same-origin HTTP classic worker, never blob/data workers.
    // Worker WASM runs in its own response context, so page script-src stays strict.
    "worker-src 'self'",
    "child-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
