import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { createEmptyCard, reviewQueue } from "../src/review";
import type { Flashcard } from "../src/models";
const now = new Date("2026-11-27T10:00:00");
const card = (id: string, seen = false): Flashcard => ({
  id,
  kind: "card",
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  version: 1,
  question: id,
  answer: "a",
  explanation: "",
  tags: [],
  importance: 3,
  source: "",
  fsrs: createEmptyCard(new Date("2026-11-26")),
  history: seen ? [{ at: "2026-11-26T10:00:00", rating: 3 }] : [],
});
describe("review queue", () => {
  it("caps new cards while keeping old due cards", () => {
    const cards = [card("new1"), card("new2"), card("old", true)];
    expect(reviewQueue(cards, "due", 1, "", now).map((c) => c.id)).toEqual([
      "old",
      "new1",
    ]);
  });
  it("counts introductions across subjects", () => {
    const cards = [
      {
        ...card("today", true),
        history: [{ at: now.toISOString(), rating: 3 }],
      },
      card("new"),
    ];
    expect(reviewQueue(cards, "new", 1, "", now)).toHaveLength(0);
  });
  it("keeps old cards when new limit is zero", () =>
    expect(
      reviewQueue([card("old", true), card("new")], "due", 0, "", now).map(
        (c) => c.id,
      ),
    ).toEqual(["old"]));
});

import { db, saveEntity } from "../src/db";
import { reviewCard } from "../src/review";
import { defaultPreferences } from "../src/models";
describe("transactional new-card cap", () => {
  it("does not introduce two different cards concurrently when one slot remains", async () => {
    await db.delete();
    await db.open();
    await db.settings.put({ ...defaultPreferences, dailyNewLimit: 1 });
    const first = await saveEntity(card("atomic1")),
      second = await saveEntity(card("atomic2"));
    const results = await Promise.allSettled([
      reviewCard(first.id, first.version, 3, now),
      reviewCard(second.id, second.version, 3, now),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const all = (await db.records.toArray()) as Flashcard[];
    expect(all.reduce((n, c) => n + c.history.length, 0)).toBe(1);
  });
});
