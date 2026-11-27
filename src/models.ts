import type { Card as FSRSCard } from "ts-fsrs";
export type Kind =
  | "target"
  | "subject"
  | "unit"
  | "session"
  | "task"
  | "note"
  | "card"
  | "attempt"
  | "question";
export interface Base {
  id: string;
  kind: Kind;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt?: string;
}
export interface Entity extends Base {
  title?: string;
  targetId?: string;
  subjectId?: string;
  unitId?: string;
  [key: string]: unknown;
}
export interface Target extends Entity {
  kind: "target";
  title: string;
  examDate: string;
  goalMinutes: number;
  passCriteria: string;
}
export interface Subject extends Entity {
  kind: "subject";
  title: string;
  targetId: string;
  importance: number;
  mastery: number;
  requiredMinutes: number;
  status: string;
}
export interface Unit extends Entity {
  kind: "unit";
  title: string;
  targetId: string;
  subjectId: string;
  importance: number;
  mastery: number;
  status: string;
}
export interface Segment {
  start: number;
  end: number;
}
export interface Session extends Entity {
  kind: "session";
  targetId: string;
  subjectId: string;
  unitId: string;
  method: string;
  segments: Segment[];
  minutes: number;
  memo: string;
}
export interface Task extends Entity {
  kind: "task";
  targetId: string;
  subjectId: string;
  date: string;
  minutes: number;
  completed: boolean;
  review: boolean;
  planId: string;
}
export interface Note extends Entity {
  kind: "note";
  title: string;
  body: string;
  tags: string[];
  bookmark: boolean;
  importance: number;
  source: string;
  verifiedOn: string;
}
export type CardType = "qa" | "formula" | "number";
export type SourceStatus = "extracted" | "unverified" | "verified";
export interface Citation {
  url: string;
  locator: string;
  asOf: string;
  checkedOn: string;
}
export interface LearningSourceMetadata {
  cardType?: CardType;
  answerUnit?: string;
  conditions?: string;
  originalText?: string;
  sourceUrl?: string;
  sourceQuestionId?: string;
  sourceStatus?: SourceStatus;
  citations?: Citation[];
  batchId?: string;
}
export interface ReferenceSite {
  id: string;
  name: string;
  url: string;
  targetId: string;
  priority: number;
  asOf: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt?: string;
}
export interface Flashcard extends Entity, LearningSourceMetadata {
  kind: "card";
  question: string;
  answer: string;
  explanation: string;
  tags: string[];
  importance: number;
  source: string;
  noteId?: string;
  fsrs: FSRSCard;
  history: { at: string; rating: number }[];
}
export interface Question extends Entity, LearningSourceMetadata {
  kind: "question";
  question: string;
  answer: string;
  explanation: string;
  source: string;
  choices: string[];
  importance?: number;
  tags?: string[];
  cause: string;
  wrongCount: number;
}
export interface Attempt extends Entity {
  kind: "attempt";
  questionId?: string;
  total: number;
  correct: number;
  cause: string;
  date: string;
}
export interface TimerState {
  id: "active";
  token: string;
  mode: "stopwatch" | "countdown" | "pomodoro";
  targetId: string;
  subjectId: string;
  unitId: string;
  method: string;
  startedAt: number;
  runningSince: number | null;
  segments: Segment[];
  durationMinutes: number;
  focusMinutes: number;
  breakMinutes: number;
  phase: "focus" | "break";
}
export interface Preferences {
  id: "preferences";
  theme: "light" | "dark" | "system";
  dailyNewLimit: number;
  weekdayMinutes: number[];
  unavailableDates: string[];
  reviewRatio: number;
  bufferDays: number;
  lastTimer?: Partial<TimerState>;
}
export const defaultPreferences: Preferences = {
  id: "preferences",
  theme: "system",
  dailyNewLimit: 20,
  weekdayMinutes: [60, 60, 60, 60, 60, 120, 120],
  unavailableDates: [],
  reviewRatio: 0.2,
  bufferDays: 2,
};
export const today = () => localDate(new Date());
export function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
