import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { SafeMarkdown } from "../src/Learning";
describe("Safe Markdown integration", () => {
  it("renders math and tables with bundled dependencies", () => {
    const s = renderToStaticMarkup(
      <SafeMarkdown>{"| A | B |\n|---|---|\n| 1 | 2 |\n\n$x^2$"}</SafeMarkdown>,
    );
    expect(s).toContain("<table>");
    expect(s).toContain("katex");
    expect(s).toContain("<math");
  });
  it("discards raw scripts, external images, and unsafe links", () => {
    const s = renderToStaticMarkup(
      <SafeMarkdown>
        {
          "<script>alert(1)</script>\n\n![remote](https://example.com/track)\n\n[bad](javascript:alert%281%29)\n\n$\\includegraphics{https://example.com/math}$"
        }
      </SafeMarkdown>,
    );
    expect(s).not.toContain("<script");
    expect(s).not.toContain("<img");
    expect(s).not.toContain('href="javascript');
    expect(s).not.toContain('src="https://');
  });
});
