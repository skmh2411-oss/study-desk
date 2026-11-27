import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHARING_SELECTION,
  sharingCandidates,
  sharedRecords,
  sharingSignature,
  buildStudyPrompt,
  type SharingSelection,
} from "../src/promptSharing";
import {
  normalizeSupabaseOrigin,
  buildCsp,
  assertApprovedSyncOrigin,
} from "../src/security";
import type { Entity } from "../src/models";
const sdk = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: sdk.createClient }));
import { validateSyncConfig, signInSync } from "../src/sync";

const base = {
  createdAt: "2026-11-27T01:02:03Z",
  updatedAt: "2026-11-27T01:02:03Z",
  version: 7,
};
const extras = {
  access_token: "DO-NOT-SEND-ACCESS-TOKEN",
  password: "DO-NOT-SEND-PASSWORD",
  custom: { secret: "DO-NOT-SEND-CUSTOM" },
  sync: { refresh_token: "DO-NOT-SEND-REFRESH-TOKEN" },
};
const entity = (
  id: string,
  kind: Entity["kind"],
  fields: Record<string, unknown>,
): Entity => ({ ...base, ...extras, id, kind, ...fields });
const rows: Entity[] = [
  entity("target-A", "target", {
    title: "Selected target",
    examDate: "2026-12-31",
    goalMinutes: 600,
    passCriteria: "70%",
  }),
  entity("target-B", "target", {
    title: "UNSELECTED-TARGET-TEXT",
    examDate: "2026-12-31",
    goalMinutes: 600,
    passCriteria: "",
  }),
  entity("subject-A", "subject", {
    title: "Subject A",
    targetId: "target-A",
    importance: 5,
    mastery: 20,
    requiredMinutes: 120,
    status: "学習中",
  }),
  entity("unit-A", "unit", {
    title: "Unit A",
    targetId: "target-A",
    subjectId: "subject-A",
    importance: 3,
    mastery: 30,
    status: "学習中",
  }),
  entity("note-A", "note", {
    title: "Explicit note",
    body: "EXPLICIT-SELECTED-NOTE-BODY",
    targetId: "target-A",
    subjectId: "subject-A",
    unitId: "unit-A",
    tags: ["test"],
    bookmark: true,
    importance: 4,
    source: "Official source",
    verifiedOn: "2026-11-27",
  }),
  entity("note-unselected", "note", {
    title: "Unselected note",
    body: "DO-NOT-SEND-UNSELECTED-NOTE",
    targetId: "target-A",
    subjectId: "subject-A",
    tags: [],
    importance: 3,
  }),
  entity("note-deleted", "note", {
    title: "Deleted note",
    body: "DO-NOT-SEND-DELETED-NOTE",
    targetId: "target-A",
    deletedAt: "2026-11-27T02:00:00Z",
  }),
  entity("note-B", "note", {
    title: "Other target",
    body: "DO-NOT-SEND-OTHER-TARGET",
    targetId: "target-B",
    subjectId: "subject-B",
    unitId: "unit-B",
  }),
  entity("session-A", "session", {
    targetId: "target-A",
    subjectId: "subject-A",
    unitId: "unit-A",
    minutes: 30,
    segments: [{ start: 1795734245123, end: 1795736045123 }],
    method: "読書",
    memo: "PRIVATE-SESSION-MEMO",
  }),
  entity("attempt-A", "attempt", {
    targetId: "target-A",
    subjectId: "subject-A",
    total: 10,
    correct: 7,
    date: "2026-11-27",
    cause: "PRIVATE-ATTEMPT-CAUSE",
  }),
  entity("card-A", "card", {
    targetId: "target-A",
    subjectId: "subject-A",
    question: "Explicit question",
    answer: "Explicit answer",
    explanation: "Explicit explanation",
    importance: 4,
    tags: ["test"],
    source: "Official source",
    fsrs: {
      due: new Date("2026-11-27"),
      stability: 5,
      difficulty: 3,
      state: 2,
    },
    history: [{ at: "2026-11-27T01:23:45Z", rating: 1 }],
  }),
];
const selection = (
  patch: Partial<SharingSelection> = {},
): SharingSelection => ({
  ...DEFAULT_SHARING_SELECTION,
  kinds: [...DEFAULT_SHARING_SELECTION.kinds],
  ids: [],
  ...patch,
});
beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_ORIGIN", "");
  sdk.createClient.mockReset();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function directives(csp: string) {
  return new Map(
    csp
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => {
        const [name, ...tokens] = v.split(/\s+/);
        return [name, tokens] as const;
      }),
  );
}

describe("Independent selected-sharing privacy audit", () => {
  it("shares nothing until individual records are selected", () => {
    expect(sharedRecords(rows, selection())).toEqual([]);
  });
  it("omits unselected/deleted/out-of-scope records even when IDs are supplied", () => {
    const selected = selection({
      targetId: "target-A",
      kinds: ["note"],
      ids: ["note-A", "note-deleted", "note-B", "target-B"],
    });
    const payload = sharedRecords(rows, selected);
    const json = JSON.stringify(payload);
    expect(payload).toHaveLength(1);
    expect(json).toContain("EXPLICIT-SELECTED-NOTE-BODY");
    for (const marker of [
      "DO-NOT-SEND-UNSELECTED-NOTE",
      "DO-NOT-SEND-DELETED-NOTE",
      "DO-NOT-SEND-OTHER-TARGET",
      "UNSELECTED-TARGET-TEXT",
    ])
      expect(json).not.toContain(marker);
  });
  it("fails closed for an inconsistent target/subject/unit scope", () => {
    const selected = selection({
      targetId: "target-B",
      subjectId: "subject-A",
      unitId: "unit-A",
      ids: rows.map((e) => e.id),
    });
    expect(sharingCandidates(rows, selected)).toEqual([]);
    expect(sharedRecords(rows, selected)).toEqual([]);
  });
  it("projects approved learning fields instead of copying record/auth/sync metadata", () => {
    const selected = selection({
      ids: [
        "target-A",
        "subject-A",
        "unit-A",
        "note-A",
        "session-A",
        "attempt-A",
        "card-A",
      ],
    });
    const payload = sharedRecords(rows, selected);
    const json = JSON.stringify(payload);
    for (const marker of [
      "DO-NOT-SEND-ACCESS-TOKEN",
      "DO-NOT-SEND-PASSWORD",
      "DO-NOT-SEND-CUSTOM",
      "DO-NOT-SEND-REFRESH-TOKEN",
      "PRIVATE-SESSION-MEMO",
      "PRIVATE-ATTEMPT-CAUSE",
    ])
      expect(json).not.toContain(marker);
    for (const record of payload)
      for (const key of [
        "createdAt",
        "updatedAt",
        "version",
        "deletedAt",
        "segments",
        "history",
        "fsrs",
        "access_token",
        "password",
        "custom",
        "sync",
      ])
        expect(record).not.toHaveProperty(key);
    expect(json).not.toContain("1795734245123");
    expect(json).toContain("Explicit question");
    expect(json).toContain("Explicit answer");
  });
  it("includes memo/cause only after their explicit opt-in", () => {
    const selected = selection({
      ids: ["session-A", "attempt-A"],
      includePrivateNotes: true,
    });
    const json = JSON.stringify(sharedRecords(rows, selected));
    expect(json).toContain("PRIVATE-SESSION-MEMO");
    expect(json).toContain("PRIVATE-ATTEMPT-CAUSE");
    expect(json).not.toContain("DO-NOT-SEND");
  });
  it("changes prompt signature after record selection, filters, private opt-in, request or instructions change", () => {
    const selected = selection({ ids: ["note-A"] });
    const original = sharingSignature(rows, selected, "request", "detail");
    for (const change of [
      { ids: [] },
      { targetId: "target-B" },
      { subjectId: "subject-A" },
      { unitId: "unit-A" },
      { kinds: ["card"] as Entity["kind"][] },
      { includePrivateNotes: true },
    ])
      expect(
        sharingSignature(rows, { ...selected, ...change }, "request", "detail"),
      ).not.toBe(original);
    expect(
      sharingSignature(rows, selected, "other request", "detail"),
    ).not.toBe(original);
    expect(
      sharingSignature(rows, selected, "request", "other detail"),
    ).not.toBe(original);
  });
  it("changes prompt signature after selected content is edited, removed or trashed", () => {
    const selected = selection({ ids: ["note-A"] });
    const original = sharingSignature(rows, selected, "request", "detail");
    const edited = rows.map((e) =>
      e.id === "note-A" ? { ...e, body: "Changed note body", version: 8 } : e,
    );
    expect(sharingSignature(edited, selected, "request", "detail")).not.toBe(
      original,
    );
    expect(
      sharingSignature(
        rows.filter((e) => e.id !== "note-A"),
        selected,
        "request",
        "detail",
      ),
    ).not.toBe(original);
    expect(
      sharingSignature(
        rows.map((e) =>
          e.id === "note-A" ? { ...e, deletedAt: "2026-11-27T03:00:00Z" } : e,
        ),
        selected,
        "request",
        "detail",
      ),
    ).not.toBe(original);
  });
  it("builds the prompt solely from the provided projected payload", () => {
    const payload = sharedRecords(rows, selection({ ids: ["note-A"] }));
    const prompt = buildStudyPrompt(
      "要点まとめの作成",
      "Include exceptions",
      payload,
    );
    expect(prompt).toContain("EXPLICIT-SELECTED-NOTE-BODY");
    expect(prompt).toContain("Include exceptions");
    expect(prompt).not.toContain("DO-NOT-SEND");
    expect(prompt).not.toContain("PRIVATE-SESSION-MEMO");
  });
});

describe("Independent CSP and approved-sync-origin audit", () => {
  it("defaults to same-origin connections with active-content containment", () => {
    const d = directives(buildCsp());
    expect(d.get("connect-src")).toEqual(["'self'"]);
    for (const name of ["object-src", "base-uri", "form-action", "frame-src"])
      expect(d.get(name)).toEqual(["'none'"]);
    expect(d.get("script-src")).toContain("'self'");
    for (const token of [
      "'unsafe-inline'",
      "'unsafe-eval'",
      "*",
      "data:",
      "blob:",
      "https:",
    ])
      expect(d.get("script-src")).not.toContain(token);
    expect(d.get("style-src")).toContain("'unsafe-inline'");
  });
  it("allows only the exact configured Supabase origin, never a wildcard suffix", () => {
    const d = directives(buildCsp("https://approved.supabase.co"));
    expect(d.get("connect-src")).toEqual([
      "'self'",
      "https://approved.supabase.co",
    ]);
    expect(buildCsp("https://approved.supabase.co")).not.toContain("*.");
  });
  it("rejects malformed or broadened build-time origins", () => {
    expect(normalizeSupabaseOrigin(undefined)).toBe("");
    expect(normalizeSupabaseOrigin("")).toBe("");
    expect(normalizeSupabaseOrigin("https://approved.supabase.co/")).toBe(
      "https://approved.supabase.co",
    );
    for (const value of [
      "https://*.supabase.co",
      "http://approved.supabase.co",
      "https://approved.supabase.co.evil.test",
      "https://evil-supabase.co",
      "https://user:password@approved.supabase.co",
      "https://approved.supabase.co/other",
      "https://approved.supabase.co?access_token=x",
      "https://approved.supabase.co#fragment",
      "https://approved.supabase.co; script-src *",
    ])
      expect(() => normalizeSupabaseOrigin(value)).toThrow();
  });
  it("rejects runtime sync without approval and mismatched saved configurations before SDK initialization", async () => {
    localStorage.setItem(
      "study-desk-sync-config",
      JSON.stringify({
        url: "https://legacy.supabase.co",
        key: "sb_publishable_test",
        enabled: true,
      }),
    );
    expect(() =>
      assertApprovedSyncOrigin("https://legacy.supabase.co"),
    ).toThrow();
    expect(() =>
      validateSyncConfig({
        url: "https://legacy.supabase.co",
        key: "sb_publishable_test",
        enabled: true,
      }),
    ).toThrow();
    await expect(
      signInSync("test@example.com", "password123"),
    ).rejects.toThrow();
    expect(sdk.createClient).not.toHaveBeenCalled();
  });
  it("rejects a mismatched saved origin even after a client was initialized for the approved project", async () => {
    vi.stubEnv("VITE_SUPABASE_ORIGIN", "https://approved.supabase.co");
    const signIn = vi
      .fn()
      .mockResolvedValue({ data: { user: null }, error: null });
    sdk.createClient.mockReturnValue({ auth: { signInWithPassword: signIn } });
    localStorage.setItem(
      "study-desk-sync-config",
      JSON.stringify({
        url: "https://approved.supabase.co",
        key: "sb_publishable_test",
        enabled: true,
      }),
    );
    await signInSync("test@example.com", "password123");
    expect(signIn).toHaveBeenCalledTimes(1);
    localStorage.setItem(
      "study-desk-sync-config",
      JSON.stringify({
        url: "https://legacy.supabase.co",
        key: "sb_publishable_test",
        enabled: true,
      }),
    );
    await expect(
      signInSync("test@example.com", "password123"),
    ).rejects.toThrow();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(sdk.createClient).toHaveBeenCalledTimes(1);
  });
  it("matches the exact approved origin at runtime", () => {
    vi.stubEnv("VITE_SUPABASE_ORIGIN", "https://approved.supabase.co");
    expect(() =>
      assertApprovedSyncOrigin("https://approved.supabase.co"),
    ).not.toThrow();
    for (const value of [
      "https://other.supabase.co",
      "https://approved.supabase.co.evil.test",
      "https://approved.supabase.co:8443",
      "http://approved.supabase.co",
    ])
      expect(() => assertApprovedSyncOrigin(value)).toThrow();
  });
});

import viteConfiguration from "../vite.config";
describe("Independent production HTML policy integration audit", () => {
  it("uses the same explicit origin for generated production CSP and runtime approval", async () => {
    vi.stubEnv("VITE_SUPABASE_ORIGIN", "https://approved.supabase.co");
    const config = await (viteConfiguration as any)({
      command: "build",
      mode: "production",
    });
    const plugin = config.plugins.find(
      (p: any) => p?.name === "study-security-policy",
    );
    const output = await plugin.transformIndexHtml.handler(
      '<html><head><script src="/assets/app.js"></script></head></html>',
    );
    const policy = output.match(
      /http-equiv="Content-Security-Policy" content="([^"]+)"/,
    )?.[1];
    expect(directives(policy!).get("connect-src")).toEqual([
      "'self'",
      "https://approved.supabase.co",
    ]);
    expect(() =>
      assertApprovedSyncOrigin("https://approved.supabase.co"),
    ).not.toThrow();
    expect(() =>
      assertApprovedSyncOrigin("https://other.supabase.co"),
    ).toThrow();
  });

  it("injects production CSP before all script/resource elements", async () => {
    const config = await (viteConfiguration as any)({
      command: "build",
      mode: "production",
    });
    const plugin = config.plugins.find(
      (p: any) => p?.name === "study-security-policy",
    );
    expect(plugin).toBeDefined();
    const source =
      '<!doctype html><html><head><meta charset="UTF-8"><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body></body></html>';
    const output = await plugin.transformIndexHtml.handler(source);
    const policyPosition = output.indexOf(
      'http-equiv="Content-Security-Policy"',
    );
    expect(policyPosition).toBeGreaterThan(0);
    expect(policyPosition).toBeLessThan(output.indexOf("<script"));
    expect(policyPosition).toBeLessThan(output.indexOf("<link"));
    expect(output).toContain('name="referrer" content="no-referrer"');
    const policy = output.match(
      /http-equiv="Content-Security-Policy" content="([^"]+)"/,
    )?.[1];
    expect(policy).toBeDefined();
    expect(directives(policy!).get("connect-src")).toEqual(["'self'"]);
    expect(directives(policy!).get("script-src")).toEqual(["'self'"]);
    expect(policy).not.toContain("unsafe-eval");
  });
});
