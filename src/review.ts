import { createEmptyCard, fsrs, Rating } from "ts-fsrs";
import { localDate, type Entity, type Flashcard } from "./models";
import { db, saveEntity } from "./db";
export { createEmptyCard };
const scheduler = fsrs({ enable_fuzz: false });
export type ReviewMode =
  "due" | "weak" | "new" | "subject" | "important" | "random" | "cram";
export function reviewQueue(
  cards: Flashcard[],
  mode: ReviewMode,
  dailyLimit: number,
  subjectId = "",
  now = new Date(),
) {
  const introduced = cards.filter(
    (c) =>
      c.history.length &&
      localDate(new Date(c.history[0].at)) === localDate(now),
  ).length;
  const available = Math.max(0, dailyLimit - introduced);
  let pool = cards.filter((c) => !c.deletedAt);
  if (mode === "subject") pool = pool.filter((c) => c.subjectId === subjectId);
  if (mode === "weak")
    pool = pool.filter(
      (c) => c.fsrs.lapses > 0 || c.history.at(-1)?.rating === 1,
    );
  if (mode === "new") pool = pool.filter((c) => c.history.length === 0);
  if (mode === "important") pool = pool.filter((c) => c.importance >= 4);
  if (mode === "due") pool = pool.filter((c) => new Date(c.fsrs.due) <= now);
  if (mode === "cram")
    pool.sort(
      (a, b) => b.importance - a.importance || b.fsrs.lapses - a.fsrs.lapses,
    );
  else pool.sort((a, b) => +new Date(a.fsrs.due) - +new Date(b.fsrs.due));
  if (mode === "random")
    pool = pool
      .map((c) => ({ c, n: Math.random() }))
      .sort((a, b) => a.n - b.n)
      .map((x) => x.c);
  const due = pool.filter((c) => c.history.length > 0),
    fresh = pool.filter((c) => !c.history.length).slice(0, available);
  if (mode === "new") return fresh;
  // Alternate new and previously studied cards, with previously studied first.
  const result: Flashcard[] = [];
  for (let i = 0; i < Math.max(due.length, fresh.length); i++) {
    if (due[i]) result.push(due[i]);
    if (fresh[i]) result.push(fresh[i]);
  }
  return result;
}
export async function reviewCard(
  id: string,
  expectedVersion: number,
  rating: number,
  now = new Date(),
) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error("復習評価が不正です");
  return db.transaction(
    "rw",
    [db.records, db.outbox, db.settings],
    async () => {
      const card = (await db.records.get(id)) as Flashcard | undefined;
      if (
        !card ||
        card.deletedAt ||
        card.kind !== "card" ||
        card.version !== expectedVersion
      )
        throw new Error(
          "カードが別の画面で更新されました。読み直してください。",
        );
      if (!card.history.length) {
        const prefs = await db.settings.get("preferences");
        const all = (await db.records
          .where("kind")
          .equals("card")
          .toArray()) as Flashcard[];
        const count = all.filter(
          (c) =>
            c.history.length &&
            localDate(new Date(c.history[0].at)) === localDate(now),
        ).length;
        if (count >= (prefs?.dailyNewLimit ?? 20))
          throw new Error(
            "本日の新規カード上限に達しました。学習済みカードの復習を続けてください。",
          );
      }
      const state = {
        ...card.fsrs,
        due: new Date(card.fsrs.due),
        last_review: card.fsrs.last_review
          ? new Date(card.fsrs.last_review)
          : undefined,
      };
      const next = scheduler.repeat(state, now)[
        rating as Rating.Again | Rating.Hard | Rating.Good | Rating.Easy
      ].card;
      return saveEntity(
        {
          ...card,
          fsrs: next,
          history: [...card.history, { at: now.toISOString(), rating }],
        },
        expectedVersion,
      );
    },
  );
}
export function asCards(entities: Entity[]) {
  return entities.filter(
    (e) => e.kind === "card" && !e.deletedAt,
  ) as Flashcard[];
}
