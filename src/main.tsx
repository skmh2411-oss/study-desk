import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
import "katex/dist/katex.min.css";
import { registerSW } from "virtual:pwa-register";
const updateSW = registerSW({
  onNeedRefresh() {
    if (
      confirm("アプリの更新があります。計測状態は保存されます。更新しますか？")
    )
      void updateSW(true);
  },
});
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? (
      <main className="panel">
        <h1>画面を開けませんでした</h1>
        <p>{this.state.error}</p>
        <p>データは削除されていません。ページを再読み込みしてください。</p>
        <button onClick={() => location.reload()}>再読み込み</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
