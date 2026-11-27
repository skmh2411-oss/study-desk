import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { db, StudyDatabase, saveEntity, saveReferenceSite, trashReferenceSite, restoreReferenceSite } from "../src/db";
import { normalizeEntity } from "../src/validation";
import { normalizeReferenceSite, normalizeCitation, citationSiteStatus, referenceInstructions } from "../src/references";
import { applyImport, createBackup, entityContentKey, previewImport } from "../src/exchange";
import { type Flashcard, type Target, type Question } from "../src/models";

beforeEach(async()=>{await Promise.all(db.tables.map(table=>table.clear()));});
const envelope=(records:unknown[],extra:Record<string,unknown>={})=>JSON.stringify({format:"study-desk",schemaVersion:1,records,...extra});
const site=(extra:Record<string,unknown>={})=>normalizeReferenceSite({name:"公式",url:"https://example.org/law",...extra});
async function target(){return saveEntity<Target>({kind:"target",title:"試験",examDate:"",goalMinutes:60,passCriteria:""});}

describe("optional source metadata",()=>{
 it("keeps legacy entities compatible and preserves FSRS/history with optional metadata",async()=>{
  const old=normalizeEntity({kind:"card",question:"Q",answer:"A"}) as Flashcard;
  expect(old.cardType).toBeUndefined();
  const card=await saveEntity<Flashcard>({...old,cardType:"formula",answerUnit:"円",conditions:"税抜",originalText:"原文",sourceUrl:"https://example.org/law/1",sourceQuestionId:"q1",sourceStatus:"verified",batchId:"batch1",citations:[{url:"https://example.org/law/1",locator:"第1条",asOf:"2026-11-27",checkedOn:""}]});
  const edited=await saveEntity({...card,explanation:"追加解説"},card.version);
  expect(edited.fsrs).toEqual(card.fsrs);expect(edited.history).toEqual(card.history);
  expect(edited.sourceStatus).toBe("verified");expect(edited.citations?.[0].locator).toBe("第1条");
 });
 it("rejects unsupported metadata, unsafe URLs and invalid citation dates",()=>{
  for(const extra of [{cardType:"unsupported"},{sourceStatus:true},{sourceUrl:"javascript:alert(1)"},{citations:[{url:"https://example.org",asOf:"2026-02-30"}]}])expect(()=>normalizeEntity({kind:"card",question:"Q",answer:"A",...extra})).toThrow();
  expect(()=>normalizeCitation({url:"https://official.example@evil.example/"})).toThrow();
 });
 it("does not re-add content because import batch or citation status changes",async()=>{
  const card=await saveEntity<Flashcard>({kind:"card",question:"同じ問題",answer:"同じ解答",source:"資料"});
  const raw={...card,id:crypto.randomUUID(),cardType:"qa",batchId:"new-batch",sourceStatus:"verified",sourceUrl:"https://example.org",originalText:"OCR原文",citations:[{url:"https://example.org",locator:"p1",asOf:"",checkedOn:"2026-11-27"}]};
  expect(entityContentKey(raw as Flashcard)).toBe(entityContentKey(card));
  const preview=await previewImport(envelope([raw]));expect(preview.records).toHaveLength(0);expect(preview.duplicates).toBe(1);
  await applyImport(preview);expect(await db.records.count()).toBe(1);
  const question=await saveEntity<Question>({kind:"question",question:"Q?",answer:"正",choices:["正","誤"],explanation:"",source:"",cause:"",wrongCount:4});
  const repeated=await previewImport(envelope([{...question,id:crypto.randomUUID(),wrongCount:0,cause:"",batchId:"next"}]));expect(repeated.duplicates).toBe(1);
 });
 it("downgrades externally claimed verification at preview and revalidates at commit",async()=>{
  const preview=await previewImport(envelope([{kind:"card",question:"Q",answer:"A",sourceStatus:"verified"}]));
  expect(preview.records[0].sourceStatus).toBe("unverified");expect(preview.warnings.join(" ")).toContain("未確認");
  preview.records[0].sourceStatus="verified";
  await applyImport(preview);expect((await db.records.toArray())[0].sourceStatus).toBe("unverified");
 });
});

describe("reference registry and URL boundaries",()=>{
 it("matches exact hosts and path boundaries within global or selected targets",()=>{
  const sites=[site(),site({name:"限定",url:"https://target.example/",targetId:"target-a"})];
  expect(citationSiteStatus("https://example.org/law/1",sites)).toBe("registered");
  expect(citationSiteStatus("https://example.org/law",sites)).toBe("registered");
  for(const url of ["https://example.org.evil.test/law/1","https://evil-example.org/law/1","https://example.org/lawless","https://example.org/law/%2f../other","javascript:alert(1)"])expect(citationSiteStatus(url,sites)).toBe("external");
  expect(citationSiteStatus("",sites)).toBe("missing");
  expect(citationSiteStatus("https://target.example/",sites,"target-b")).toBe("external");
  expect(citationSiteStatus("https://target.example/",sites,"target-a")).toBe("registered");
  expect(referenceInstructions(sites,"target-b")).not.toContain("target.example");
  expect(referenceInstructions(sites,"target-a")).toContain("正確性を意味");
 });
 it("rejects malformed sites and keeps concurrent saves optimistic and local-only",async()=>{
  for(const extra of [{url:"file:///tmp/file"},{priority:0},{priority:1.5},{asOf:"2026-02-30"}])expect(()=>site(extra)).toThrow();
  const s=await saveReferenceSite({name:"公式",url:"https://example.org/law"});
  const results=await Promise.allSettled([saveReferenceSite({...s,name:"変更A"},s.version),saveReferenceSite({...s,name:"変更B"},s.version)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(await db.outbox.count()).toBe(0);
  const current=(await db.referenceSites.get(s.id))!;
  await expect(trashReferenceSite(s.id,s.version)).rejects.toThrow();
  await trashReferenceSite(s.id,current.version);const trashed=(await db.referenceSites.get(s.id))!;expect(trashed.deletedAt).toBeTruthy();
  await restoreReferenceSite(s.id,trashed.version);expect((await db.referenceSites.get(s.id))!.deletedAt).toBeUndefined();
 });
 it("prevents two tabs from registering the same site twice",async()=>{
  const results=await Promise.allSettled([saveReferenceSite({name:"A",url:"https://example.org/law"}),saveReferenceSite({name:"B",url:"https://example.org/law"})]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(await db.referenceSites.count()).toBe(1);
 });
});

describe("registry migration and portable backup",()=>{
 it("upgrades a v1 database without losing old records or tables",async()=>{
  const name=`study-migration-test-${crypto.randomUUID()}`;const previous=new Dexie(name);
  previous.version(1).stores({records:"id,kind,targetId,subjectId,updatedAt,deletedAt",timers:"id",settings:"id",outbox:"id",syncMeta:"key",conflicts:"id"});
  await previous.table("records").add({id:"existing",kind:"target",title:"以前のデータ"});
  await previous.table("settings").add({id:"preferences",theme:"dark"});previous.close();
  const upgraded=new StudyDatabase(name);
  try {await upgraded.open();expect((await upgraded.records.get("existing"))?.title).toBe("以前のデータ");expect((await upgraded.settings.get("preferences"))?.theme).toBe("dark");expect(await upgraded.referenceSites.count()).toBe(0);expect(upgraded.tables.map(t=>t.name)).toContain("timers");}
  finally {upgraded.close();await Dexie.delete(name);}
 });
 it("accepts old JSON and restores new registry backups additively without overwrites",async()=>{
  const t=await target();const s=await saveReferenceSite({name:"公式",url:"https://example.org/law",targetId:t.id,priority:1});
  const backup=await createBackup();expect(JSON.parse(backup).schemaVersion).toBe(1);expect(JSON.parse(backup).referenceSites).toHaveLength(1);
  const repeated=await previewImport(backup);expect(repeated.referenceSiteDuplicates).toBe(1);expect(repeated.referenceSites).toHaveLength(0);
  const conflict=await previewImport(envelope([],{referenceSites:[{...s,name:"無断変更"}]}));expect(conflict.referenceSiteConflicts).toBe(1);await applyImport(conflict);expect((await db.referenceSites.get(s.id))!.name).toBe("公式");
  await db.records.clear();await db.referenceSites.clear();const restore=await previewImport(backup);const result=await applyImport(restore);expect(result.referenceSitesAdded).toBe(1);expect((await db.referenceSites.get(s.id))!.targetId).toBe(t.id);
  const old=await previewImport(envelope([]));expect(old.referenceSites).toBeUndefined();await expect(applyImport(old)).resolves.toBeDefined();
 });
 it("rejects forged registry targets or URLs before writing either table",async()=>{
  await expect(previewImport(envelope([{kind:"target",title:"追加"}],{referenceSites:[{name:"invalid",url:"javascript:alert(1)"}]}))).rejects.toThrow();expect(await db.records.count()).toBe(0);
  const preview=await previewImport(envelope([{kind:"target",title:"追加"}],{referenceSites:[site()]}));preview.referenceSites![0].targetId="missing";
  await expect(applyImport(preview)).rejects.toThrow();expect(await db.records.count()).toBe(0);expect(await db.referenceSites.count()).toBe(0);
 });
});
