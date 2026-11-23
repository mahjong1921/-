import Dexie from "dexie";
import type { StoryMessage } from "./story-storage";
import type { ApiConfig } from "./settings-types";
import { simpleLLMCall } from "./api-helpers";
import { estimateTokens } from "./token-counter";
import { loadApiConfigs, resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity, keywordSearch } from "./memory-embedding";
import type { MemoryEntry } from "./memory-types";

export const DEFAULT_SEGMENT_PROMPT = `整理本段新增剧情，按时间顺序写成高密度叙事编年史（400–600中文字）。记录行动→反应→结果、明确心理和情感转折的依据、关系变化、关键原话、专有名称、时间地点、约定与未解伏笔。仅在实质性场景或剧情变化时分段。区别事实、明确心理与推测；不杜撰、不续写，不复述露骨细节。只输出摘要纯文本。`;
export const DEFAULT_STORY_SUMMARY_PROMPT = `维护从故事起点至当前的全局剧情档案，不续写。旧阶段与新阶段按长期影响分配篇幅，不因距今较远而省略。整合而非追加；每个事实、事件、心理转折仅记录一次，勿复述独立分段已有的局部动作和细节。区分确认事实、明确心理和有依据的推测。
【全局剧情脉络】从起点按时间顺序概括阶段、关键事件及因果。
【人物心理与情感演变】归纳初始状态、转折原因、长期心理轨迹与当前状态，重视情感逻辑。
【当前关系与状态】关系定位、信任、边界、承诺、目标以及最新明确变化。
【未解伏笔】尚未解决的秘密、冲突、约定和人物关系；移除已解决项。
【当前衔接点】最近事件、时间地点与未完成行动，简短记录。
控制在1000–1500中文字内，删除重复信息，不复述露骨细节，不杜撰；只输出完整更新后的纯文本摘要。`;
export type SummaryTask = { status: "running" | "paused" | "failed" | "done"; completed: number; total: number; stage: string; startedAt: string; error?: string; targetId: string; targetDigest: string; draft?: {firstId:string; lastId:string; digest:string; parts:string[]; manual?:boolean}; };
export type RecallHit = { id:string; score:number; mode:"vector"|"keyword" };
export type RecallRecord = {id:string;sessionId:string;createdAt:string;reason:string;hits:(RecallHit&{content:string;firstId:string;lastId:string})[]};

export type StoryMemoryState = {
  sessionId: string;
  enabled: boolean;
  summaryText: string;
  summaryPrompt?: string;
  segmentPrompt?: string;
  supplementalPrompt?: string;
  supplementalPosition?: "before" | "after";
  supplementalForSegment?: boolean;
  supplementalForCore?: boolean;
  summaryNeedsReroll?: boolean;
  summaryApiConfigId?: string;
  task?: SummaryTask;
  coveredThroughMessageId: string | null;
  coveredDigest: string;
  recentTurns: number;
  triggerTokens: number;
  triggerMode?: "hybrid" | "count" | "tokens" | "manual";
  triggerMessages?: number;
  recallEnabled?: boolean;
  recallTopK?: number;
  interviewEnabled?: boolean;
  interviewSummaryTurns?: number;
  crossStoryToChat?: "summary-recent" | "summary" | "full";
  crossChatToStory?: "full" | "summary-recent";
  crossMoments?: "summary-recent" | "recent" | "full";
  updatedAt: string;
};
export type StoryMemoryRevision = { id: string; sessionId: string; summaryText: string; coveredThroughMessageId: string | null; coveredDigest: string; source: "auto" | "manual" | "restore"; createdAt: string };
export type StorySegment = { id: string; sessionId: string; firstId: string; lastId: string; digest: string; content: string; createdAt: string; editedAt?:string; editHistory?:{content:string;at:string}[]; embedding?: number[]; embeddingKey?: string };
class StoryMemoryDB extends Dexie {
  states!: Dexie.Table<StoryMemoryState, string>;
  revisions!: Dexie.Table<StoryMemoryRevision, string>;
  segments!: Dexie.Table<StorySegment, string>;
  recalls!: Dexie.Table<RecallRecord,string>;
  constructor(name:string) { super(name); this.version(1).stores({ states: "sessionId", revisions: "id, sessionId, createdAt" }); this.version(2).stores({ states: "sessionId", revisions: "id, sessionId, createdAt", segments: "id, sessionId" }); this.version(3).stores({states:"sessionId",revisions:"id, sessionId, createdAt",segments:"id, sessionId",recalls:"id, sessionId, createdAt"}); }
}
const storyDb = new StoryMemoryDB("AiPhoneStoryMemoryDB");
const vnDb = new StoryMemoryDB("AiPhoneVnMemoryDB");
const memoryDb = (id:string) => id.startsWith("vn:") ? vnDb : storyDb;
const activeSummaries = new Set<string>();
const pauseRequests = new Set<string>();
const recallHits = new Map<string,RecallHit[]>();
function writeMemoryMirror(state:StoryMemoryState) {
  if(typeof localStorage==="undefined"||!state.sessionId)return;
  const {task,summaryPrompt,segmentPrompt,supplementalPrompt,...projection}=state;
  try {localStorage.setItem(`float-story-memory-v3:${state.sessionId}`,JSON.stringify(projection));}catch{}
}
export async function hydrateMemoryMirrors() {
  const ids=new Set<string>();
  for(const db of [storyDb,vnDb]) {
    const states=await db.states.toArray();
    for(const state of states){ids.add(state.sessionId);writeMemoryMirror(state);}
  }
  // Derived mirrors are not authoritative: after restore/clear, remove orphaned projections.
  if(typeof localStorage!=="undefined")try{const prefix="float-story-memory-v3:";for(const key of Object.keys(localStorage))if(key.startsWith(prefix)&&!ids.has(key.slice(prefix.length)))localStorage.removeItem(key);}catch{}
}
export const requestMemoryPause = (id:string) => { if (activeSummaries.has(id)) pauseRequests.add(id); };
export const isMemoryRunning = (id:string) => activeSummaries.has(id);
export const getMemoryRecallHits = (id:string) => recallHits.get(id) ?? [];
export async function listRecallRecords(id:string) {return (await memoryDb(id).recalls.where("sessionId").equals(id).toArray()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
export function memoryInstruction(state:StoryMemoryState,kind:"segment"|"core") {
  const template=kind==="segment"?(state.segmentPrompt?.trim()||DEFAULT_SEGMENT_PROMPT):(state.summaryPrompt?.trim()||DEFAULT_STORY_SUMMARY_PROMPT);
  const supplement=(kind==="segment"?state.supplementalForSegment!==false:state.supplementalForCore!==false)?state.supplementalPrompt?.trim():"";
  return supplement?(state.supplementalPosition==="before"?`${supplement}\n\n${template}`:`${template}\n\n${supplement}`):template;
}
export function memorySourceText(message:StoryMessage,excludedTags="think,thinking") {
  // VN inputs retain their original markup and archived-chapter reuse rules.
  if(message.sessionId.startsWith("vn:"))return message.rawContent;
  const tags=[...new Set(["think","thinking","summary",...excludedTags.split(",").map(t=>t.trim()).filter(t=>/^[\w:-]+$/.test(t))])];
  const pattern=new RegExp(`<(${tags.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`,"gi");
  return message.rawContent.replace(pattern,"").trim();
}
export function resolveMemorySummaryApi(state:StoryMemoryState,fallback:ApiConfig):ApiConfig {
  return (state.summaryApiConfigId ? loadApiConfigs().find(c=>c.id===state.summaryApiConfigId) : null) || resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || fallback;
}
export async function listStorySegments(id:string) { return (await memoryDb(id).segments.where("sessionId").equals(id).toArray()).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
export async function supplyMemoryDraft(id:string,content:string) {
  if(isMemoryRunning(id)) throw new Error("请先暂停任务。");
  const state=await loadStoryMemory(id);
  if(!state.task?.draft || state.task.status === "done" || !content.trim()) throw new Error("没有待处理分段或摘要为空。");
  await saveStoryMemory({...state,task:{...state.task,status:"paused",error:undefined,draft:{...state.task.draft,parts:[content.trim()],manual:true}}},"manual",[],state,true);
}
export function defaultStoryMemoryState(sessionId: string): StoryMemoryState {
  return { sessionId, enabled: false, summaryText: "", summaryPrompt: DEFAULT_STORY_SUMMARY_PROMPT, segmentPrompt: DEFAULT_SEGMENT_PROMPT, coveredThroughMessageId: null, coveredDigest: "", recentTurns: 6, triggerTokens: 20000, triggerMode: "hybrid", triggerMessages: 20, interviewEnabled: true, interviewSummaryTurns: 6, crossStoryToChat: "summary-recent", crossChatToStory: "full", crossMoments: "summary-recent", updatedAt: new Date().toISOString() };
}
export async function loadStoryMemory(sessionId: string): Promise<StoryMemoryState> {
  const state = (await memoryDb(sessionId).states.get(sessionId)) ?? defaultStoryMemoryState(sessionId);
  // Migrate v2 IndexedDB state to the read-only cross-scene mirror on first access.
  writeMemoryMirror(state);
  return state;
}
export async function saveStoryMemory(state: StoryMemoryState, source: StoryMemoryRevision["source"] = "manual", segments: StorySegment[] = [], expected?: StoryMemoryState | null, checkpoint = false): Promise<StoryMemoryState> {
  const db = memoryDb(state.sessionId);
  const next = { ...state, updatedAt: new Date(Math.max(Date.now(), Date.parse(expected?.updatedAt || "")+1 || 0)).toISOString() };
  await db.transaction("rw", db.states, db.revisions, db.segments, async () => {
    const stored = await db.states.get(next.sessionId);
    if (expected !== undefined && (stored ? stored.updatedAt !== expected?.updatedAt : Boolean(expected?.coveredThroughMessageId))) throw new Error("剧情记忆已被其他操作更新，请重新加载后再试。");
    await db.states.put(next);
    if (segments.length) await db.segments.bulkPut(segments);
    if (!checkpoint) await db.revisions.put({ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, sessionId: next.sessionId, summaryText: next.summaryText, coveredThroughMessageId: next.coveredThroughMessageId, coveredDigest: next.coveredDigest, source, createdAt: next.updatedAt });
  });
  // A synchronous read-through mirror for the shared short-term timeline.
  // The IndexedDB state remains authoritative; the mirror is only a projection.
  writeMemoryMirror(next);
  return next;
}
export async function listStoryMemoryRevisions(sessionId: string): Promise<StoryMemoryRevision[]> {
  return (await memoryDb(sessionId).revisions.where("sessionId").equals(sessionId).toArray()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
// FNV-1a over message IDs and original content: invalidates summaries when old text is edited or deleted.
export function storyCoveredDigest(messages: StoryMessage[]): string {
  let hash = 2166136261;
  for (const m of messages) {
    const text = `${m.id}|${m.role}|${m.rawContent}|`;
    for (let i=0;i<text.length;i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash,16777619); }
  }
  return (hash>>>0).toString(16);
}
export function resolveStoryMemoryContext(history: StoryMessage[], state: StoryMemoryState): { history: StoryMessage[]; summary: string; valid: boolean } {
  if (!state.enabled || !state.summaryText.trim() || !state.coveredThroughMessageId || history.some(m => m.sessionId !== state.sessionId)) return { history, summary: "", valid: false };
  const index = history.findIndex(m=>m.id===state.coveredThroughMessageId);
  if (index < 0 || storyCoveredDigest(history.slice(0,index+1)) !== state.coveredDigest) return { history, summary: "", valid: false };
  return { history: history.slice(index+1), summary: state.summaryText.trim(), valid: true };
}
export function cutoffForRecentTurns(history: StoryMessage[], turns: number): number {
  // Pending user input is not a completed round.
  if (history[history.length-1]?.role === "user") turns++;
  let seen = 0;
  let boundary = 0;
  for (let i=history.length-1;i>=0;i--) if (history[i].role==="user") {
    if (++seen>turns) return boundary;
    boundary = i;
  }
  return 0;
}
/** Explicit action only: never automatically spend API credits or discard context without a confirmed summary. */
export async function generateStoryMemorySummary(sessionId: string, history: StoryMessage[], current: StoryMemoryState, apiConfig: ApiConfig): Promise<StoryMemoryState> {
  if(typeof navigator!=="undefined"&&navigator.locks) return navigator.locks.request(`float-memory:${sessionId}`,{ifAvailable:true},lock=>{
    if(!lock)throw new Error("其他页面正在处理该会话的摘要任务。");
    return runMemorySummary(sessionId,history,current,apiConfig);
  });
  return runMemorySummary(sessionId,history,current,apiConfig);
}
async function runMemorySummary(sessionId:string,history:StoryMessage[],current:StoryMemoryState,apiConfig:ApiConfig):Promise<StoryMemoryState> {
  if (!sessionId || current.sessionId !== sessionId || history.some(m => m.sessionId !== sessionId)) throw new Error("剧情会话不一致。");
  if (activeSummaries.has(sessionId)) throw new Error("已有摘要任务运行中。");
  apiConfig=resolveMemorySummaryApi(current,apiConfig);
  activeSummaries.add(sessionId);
  pauseRequests.delete(sessionId);
  const db = memoryDb(sessionId);
  let working = current;
  let expected: StoryMemoryState | null = null;
  let task: SummaryTask | undefined;
  const checkpoint = async (next: StoryMemoryState, segments: StorySegment[] = [], commit = false) => {
    working = await saveStoryMemory(next,"auto",segments,expected,!commit);
    expected = working;
  };
  const fail = (stage:string,result:{error?:string;finishReason?:string;wasTruncated?:boolean}) => {
    let detail=result.error || (result.wasTruncated ? "输出被截断" : "正文为空");
    if(apiConfig.apiKey)detail=detail.split(apiConfig.apiKey).join("[密钥已隐藏]");
    return new Error(`${stage} · ${apiConfig.defaultModel}：${detail.slice(0,500)}${result.finishReason ? ` (${result.finishReason})` : ""}`);
  };
  try {
  expected = (await db.states.get(sessionId)) ?? null;
  if (expected && expected.updatedAt !== current.updatedAt) throw new Error("剧情记忆已有更新，请重新打开管理页面。");
  let cutoff = cutoffForRecentTurns(history, Math.max(1,current.recentTurns));
  const oldTask = current.task;
  const target = oldTask && oldTask.status !== "done" ? history.findIndex(m=>m.id===oldTask.targetId)+1 : 0;
  const resume = !!(target && target<=cutoff && storyCoveredDigest(history.slice(0,target))===oldTask?.targetDigest);
  if (resume) cutoff=target;
  if (cutoff===0) throw new Error("剧情不足以压缩：需要更多历史对话。");
  const previous = resolveStoryMemoryContext(history,{...current,enabled:true});
  // If old coverage is stale, rebuild from the current source; old segments
  // remain inaccessible unless their exact original source range still matches.
  const oldCovered = previous.valid ? history.findIndex(m=>m.id===current.coveredThroughMessageId)+1 : 0;
  const pending = history.slice(oldCovered,cutoff);
  if (!pending.length) { if(resume && oldTask) { await checkpoint({...working,task:{...oldTask,status:"done",stage:"全部完成",draft:undefined}}); return working; } throw new Error("目前没有新的可压缩剧情。"); }
  let rolling = previous.valid ? previous.summary : "";
  const excludedTags=sessionId.startsWith("vn:")?undefined:await import("./story-storage").then(m=>m.loadStorySessions().find(s=>s.id===sessionId)?.contextExcludedTags).catch(()=>undefined);
  const batches: {texts:string[]; messages:StoryMessage[]; prebuilt?:string}[] = [];
  let chunk = "";
  let chunkMessages: StoryMessage[] = [];
  const flush = () => { if (chunk) batches.push({texts:[chunk],messages:chunkMessages}); chunk=""; chunkMessages=[]; };
  for (let p=0;p<pending.length;p++) {
    const msg=pending[p];
    const archived=(msg as StoryMessage & {archivedSummary?:{content:string;endId:string}}).archivedSummary;
    if(archived){const end=pending.findIndex((m,i)=>i>=p&&m.id===archived.endId);if(end>=p){flush();batches.push({texts:[],messages:pending.slice(p,end+1),prebuilt:archived.content});p=end;continue;}}
    const chapterIndex=(msg as StoryMessage & {chapterIndex?:number}).chapterIndex;
    if(chunkMessages.length && chapterIndex!==undefined && (chunkMessages[chunkMessages.length-1] as StoryMessage & {chapterIndex?:number}).chapterIndex!==chapterIndex) flush();
    const body = memorySourceText(msg,excludedTags) || "（无正文）";
    const line = `[${msg.role === "user" ? "用户" : msg.role === "assistant" ? "角色" : "系统"}] ${body}
`;
    if (chunk && (estimateTokens(chunk+line)>5500 || chunkMessages.length >= 20)) flush();
    if (estimateTokens(line)>5500) {
      // Long single message: split without skipping its content.
      const texts:string[]=[]; for (let pos=0;pos<line.length;pos+=6000) texts.push(line.slice(pos,pos+6000));
      batches.push({texts,messages:[msg]});
    } else { chunk+=line; chunkMessages.push(msg); }
  }
  flush();
  task = {status:"running",completed:resume ? oldTask!.completed : 0,total:(resume ? oldTask!.completed : 0)+batches.length,stage:"准备",startedAt:resume ? oldTask!.startedAt : new Date().toISOString(),targetId:history[cutoff-1].id,targetDigest:storyCoveredDigest(history.slice(0,cutoff)),draft:resume ? oldTask!.draft : undefined};
  await checkpoint({...working, task});
  const stop = async () => { if (!pauseRequests.has(sessionId)) return false; task={...task!,status:"paused",stage:"已暂停"}; await checkpoint({...working,task}); return true; };
  for (let i=0;i<batches.length;i++) {
    const batch = batches[i];
    const firstId=batch.messages[0].id,lastId=batch.messages[batch.messages.length-1].id,digest=storyCoveredDigest(batch.messages);
    const id=JSON.stringify([sessionId,firstId,lastId,digest]);
    const label:string=`${task.completed+1}/${task.total}`;
    const matchingDraft:SummaryTask["draft"] = task.draft?.firstId===firstId && task.draft.lastId===lastId && task.draft.digest===digest ? task.draft : undefined;
    const parts:string[] = matchingDraft ? [...matchingDraft.parts] : batch.prebuilt ? [batch.prebuilt] : [];
    if (await stop()) return working;
    for(let j=matchingDraft?.manual ? batch.texts.length : parts.length;j<batch.texts.length;j++) {
      task={...task,stage:`独立摘要 ${label}`,draft:{firstId,lastId,digest,parts:[...parts]}};
      await checkpoint({...working,task});
      const segmentResult = await simpleLLMCall(apiConfig,[{role:"system",content:memoryInstruction(working,"segment")},{role:"user",content:`【独立剧情分段】\n${batch.texts[j]}`}],{temperature:0.2,nativeSystemInstruction:true,label:`独立剧情分段 ${label}`});
      if (!segmentResult.content?.trim() || segmentResult.wasTruncated) throw fail(task.stage,segmentResult);
      parts.push(segmentResult.content.trim());
      task={...task,draft:{firstId,lastId,digest,parts:[...parts]}};
      await checkpoint({...working,task});
      if(await stop()) return working;
    }
    const segment:StorySegment={id,sessionId,firstId,lastId,digest,content:parts.join("\n\n"),createdAt:new Date().toISOString()};
    task={...task,stage:`累计摘要 ${label}`,draft:{firstId,lastId,digest,parts:[...parts],manual:matchingDraft?.manual}}; await checkpoint({...working,task});
    const result = await simpleLLMCall(apiConfig,[{role:"system",content:memoryInstruction(working,"core")},{role:"user",content:`【旧记忆】\n${rolling || "（无）"}\n【新增分段摘要】\n${segment.content}`}],{temperature:0.2,nativeSystemInstruction:true,label:`剧情记忆压缩 ${label}`});
    if (!result.content?.trim() || result.wasTruncated) throw fail(task.stage,result);
    rolling=result.content.trim();
    const covered=history.findIndex(m=>m.id===lastId)+1;
    task={...task,completed:task.completed+1,stage:"已保存分段",draft:undefined};
    await checkpoint({...working,enabled:true,summaryText:rolling,coveredThroughMessageId:lastId,coveredDigest:storyCoveredDigest(history.slice(0,covered)),task},[segment],true);
    if(await stop()) return working;
    // Embeddings are optional and recoverable lazily; the summary is already committed.
    const embeddingApi=working.recallEnabled===false ? null : resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if(embeddingApi && resolveEmbeddingModel(embeddingApi)) {
      task={...task,stage:`向量索引 ${label}`}; await checkpoint({...working,task});
      try { const vector=await generateEmbedding(segment.content,embeddingApi); if(validVector(vector)) await db.segments.put({...segment,embedding:vector,embeddingKey:embeddingKey(embeddingApi)}); } catch { /* lazy retry */ }
    }
  }
  task={...task,status:"done",stage:"全部完成"}; await checkpoint({...working,task});
  return working;
  } catch(error) {
    if(task) { try { await checkpoint({...working,task:{...(working.task ?? task),status:"failed",error:error instanceof Error ? error.message : String(error)}}); } catch { /* concurrent change: never overwrite */ } }
    throw error;
  } finally { activeSummaries.delete(sessionId); pauseRequests.delete(sessionId); }
}

function embeddingKey(api: ApiConfig): string { return JSON.stringify([api.id,api.provider,api.baseUrl,resolveEmbeddingModel(api)]); }
function validVector(vector: number[] | null | undefined): vector is number[] { return !!vector?.length && vector.every(Number.isFinite) && vector.some(v => v !== 0); }

/** Checks complete, non-overlapping coverage. Unlike retrieval, identical content is not a reason to omit a source range. */
export function orderedRerollSegments(segments:StorySegment[],history:StoryMessage[],state:StoryMemoryState) {
  if(!resolveStoryMemoryContext(history,{...state,enabled:true}).valid)throw new Error("累计摘要覆盖范围已失效，不能仅重 Roll，请先整理原文。");
  const end=history.findIndex(m=>m.id===state.coveredThroughMessageId);
  const ranges=segments.map(s=>({s,a:history.findIndex(m=>m.id===s.firstId),b:history.findIndex(m=>m.id===s.lastId)})).filter(({s,a,b})=>s.sessionId===state.sessionId&&s.content.trim()&&a>=0&&b>=a&&b<=end&&storyCoveredDigest(history.slice(a,b+1))===s.digest);
  // Prefer a complete path, not a greedily chosen overlap from a previous full rebuild.
  const paths=new Map<number,typeof ranges>([[end+1,[]]]);
  for(let a=end;a>=0;a--){const choices=ranges.filter(r=>r.a===a&&paths.has(r.b+1)).sort((x,y)=>y.s.createdAt.localeCompare(x.s.createdAt));if(choices.length){const r=choices[0];paths.set(a,[r,...paths.get(r.b+1)!]);}}
  if(!paths.has(0))throw new Error("历史分段未完整覆盖累计摘要范围。为防止遗失旧剧情，暂不能仅重 Roll。");
  return paths.get(0)!.map(r=>r.s);
}
const segmentFingerprint=(segments:StorySegment[])=>JSON.stringify(segments.map(s=>[s.id,s.content,s.editedAt]));
export type RerollPreview={sessionId:string;expectedAt:string;coveredDigest:string;coveredThroughMessageId:string|null;fingerprint:string;summary:string;count:number};
async function withMemoryLock<T>(id:string,fn:()=>Promise<T>):Promise<T>{
  if(typeof navigator!=="undefined"&&navigator.locks)return navigator.locks.request(`float-memory:${id}`,{ifAvailable:true},lock=>{if(!lock)throw new Error("其他页面正在整理记忆。");return fn();});
  return fn();
}
export async function previewMemoryReroll(id:string,history:StoryMessage[],current:StoryMemoryState,api:ApiConfig,onProgress?:(label:string)=>void):Promise<RerollPreview>{
  return withMemoryLock(id,async()=>{
    if(isMemoryRunning(id)||current.sessionId!==id)throw new Error("记忆任务正在运行或会话不一致。");
    activeSummaries.add(id);
    try {
      const stored=await loadStoryMemory(id);
      if(stored.updatedAt!==current.updatedAt)throw new Error("设置已变化，请重新打开管理页。");
      const segments=orderedRerollSegments(await listStorySegments(id),history,stored);
      api=resolveMemorySummaryApi(current,api);
      let items=segments.map((s,i)=>`【分段 ${i+1}】\n${s.content}`);
      const prompt=memoryInstruction(current,"core");
      for(let level=0;level<8;level++){
        const groups:string[][]=[];let group:string[]=[];let size=0;
        for(const item of items){const n=estimateTokens(item);if(n>12000)throw new Error("存在过长的手动分段，请先压缩该段再重 Roll。");if(group.length&&size+n>12000){groups.push(group);group=[];size=0;}group.push(item);size+=n;}if(group.length)groups.push(group);
        const results:string[]=[];
        for(let i=0;i<groups.length;i++){
          onProgress?.(`第 ${level+1} 层 · ${i+1}/${groups.length}`);
          const result=await simpleLLMCall(api,[{role:"system",content:prompt},{role:"user",content:`【从历史分段重建${groups.length===1?"全局":"局部阶段"}累计摘要】\n严格按给定时间顺序整合，不复述重复信息，不遗漏较早阶段。${groups.length>1?"这是连续的局部范围，保留该范围关键转折供后续全局整合。":""}\n${groups[i].join("\n\n")}`}],{temperature:0.2,nativeSystemInstruction:true,label:"累计摘要重 Roll"});
          if(!result.content?.trim()||result.wasTruncated)throw new Error(`重 Roll ${i+1}/${groups.length} 失败：${(result.error||result.finishReason||"输出为空或截断").slice(0,400)}`);
          results.push(result.content.trim());
        }
        if(groups.length===1)return {sessionId:id,expectedAt:stored.updatedAt,coveredDigest:stored.coveredDigest,coveredThroughMessageId:stored.coveredThroughMessageId,fingerprint:segmentFingerprint(segments),summary:results[0],count:segments.length};
        items=results.map((s,i)=>`【连续阶段 ${i+1}】\n${s}`);
      }
      throw new Error("历史摘要过长，无法在有限层数内重建，旧摘要未改变。");
    }finally{activeSummaries.delete(id);}
  });
}
export async function commitMemoryReroll(preview:RerollPreview,history:StoryMessage[],summary=preview.summary){
  const id=preview.sessionId;
  return withMemoryLock(id,async()=>{
    if(isMemoryRunning(id))throw new Error("已有记忆任务运行中。");
    const state=await loadStoryMemory(id);
    if(!summary.trim()||state.updatedAt!==preview.expectedAt||state.coveredDigest!==preview.coveredDigest||state.coveredThroughMessageId!==preview.coveredThroughMessageId||segmentFingerprint(orderedRerollSegments(await listStorySegments(id),history,state))!==preview.fingerprint)throw new Error("预览后记忆或原文已变化，请重新生成预览。");
    return saveStoryMemory({...state,summaryText:summary.trim(),summaryNeedsReroll:false},"manual",[],state);
  });
}
export async function editMemorySegment(id:string,segmentId:string,history:StoryMessage[],content:string,expectedContent:string){
  return withMemoryLock(id,async()=>{
    if(isMemoryRunning(id)||!content.trim())throw new Error("整理任务运行中或摘要为空。");
    const state=await loadStoryMemory(id),db=memoryDb(id);
    const segment=await db.segments.get(segmentId);
    const a=history.findIndex(m=>m.id===segment?.firstId),b=history.findIndex(m=>m.id===segment?.lastId);
    if(!segment||segment.sessionId!==id||segment.content!==expectedContent||history.some(m=>m.sessionId!==id)||a<0||b<a||storyCoveredDigest(history.slice(a,b+1))!==segment.digest)throw new Error("分段已变化或原文范围失效。");
    if(segment.content===content.trim())return state;
    const at=new Date().toISOString();
    return saveStoryMemory({...state,summaryNeedsReroll:true},"manual",[{...segment,content:content.trim(),editedAt:at,editHistory:[...(segment.editHistory??[]),{content:segment.content,at}],embedding:undefined,embeddingKey:undefined}],state,true);
  });
}
export async function reindexMemorySegment(id:string,segmentId:string){
  return withMemoryLock(id,async()=>{
    if(isMemoryRunning(id))throw new Error("已有记忆任务运行中。");
    const db=memoryDb(id),s=await db.segments.get(segmentId),api=resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if(!s||s.sessionId!==id||!api||!resolveEmbeddingModel(api))throw new Error("分段不存在或未配置 Embedding API。");
    const embedding=await generateEmbedding(s.content,api);
    if(!validVector(embedding))throw new Error("向量索引生成失败。");
    await db.transaction("rw",db.segments,async()=>{const now=await db.segments.get(s.id);if(!now||now.content!==s.content||now.editedAt!==s.editedAt)throw new Error("分段已更新，请重试。");await db.segments.put({...now,embedding,embeddingKey:embeddingKey(api)});});
  });
}

/** Only segments fully covered by the CURRENT valid summary may be recalled. */
export function filterStorySegments(segments: StorySegment[], history: StoryMessage[], state: StoryMemoryState): StorySegment[] {
  if (!resolveStoryMemoryContext(history,state).valid || history.some(m => m.sessionId !== state.sessionId)) return [];
  const end = history.findIndex(m => m.id === state.coveredThroughMessageId);
  const seen = new Set<string>();
  const covered = new Set<number>();
  return [...segments].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).filter(s => {
    if (s.sessionId !== state.sessionId || !s.content.trim()) return false;
    const a = history.findIndex(m => m.id === s.firstId), b = history.findIndex(m => m.id === s.lastId);
    if (a < 0 || b < a || b > end || storyCoveredDigest(history.slice(a,b+1)) !== s.digest) return false;
    const key = s.content.replace(/\s+/g, "").trim();
    if (seen.has(key) || key === state.summaryText.replace(/\s+/g, "").trim()) return false;
    for (let i=a;i<=b;i++) if (covered.has(i)) return false;
    for (let i=a;i<=b;i++) covered.add(i);
    seen.add(key); return true;
  });
}

export async function recallStorySegments(history: StoryMessage[], state: StoryMemoryState, allowEmbedding = true): Promise<StorySegment[]> {
  const db=memoryDb(state.sessionId);
  const finish=async(result:StorySegment[],reason:string,hits:RecallHit[]=[]):Promise<StorySegment[]>=>{
    if(allowEmbedding&&state.sessionId){
      recallHits.set(state.sessionId,hits);
      try{
        const record:RecallRecord={id:`${Date.now()}_${Math.random().toString(36).slice(2)}`,sessionId:state.sessionId,createdAt:new Date().toISOString(),reason,hits:hits.flatMap(h=>{const s=result.find(x=>x.id===h.id);return s?[{...h,content:s.content,firstId:s.firstId,lastId:s.lastId}]:[];})};
        await db.transaction("rw",db.recalls,async()=>{await db.recalls.put(record);const prior=(await db.recalls.where("sessionId").equals(state.sessionId).toArray()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));await db.recalls.bulkDelete(prior.slice(20).map(r=>r.id));});
      }catch{/* logging must not alter retrieval */}
    }
    return result;
  };
  try {
  if(allowEmbedding) recallHits.set(state.sessionId,[]);
  if (state.recallEnabled === false || !state.sessionId) return finish([],"召回关闭或无会话");
  const resolved = resolveStoryMemoryContext(history,state);
  if (!resolved.valid) return finish([],"无有效累计摘要");
  const segments = filterStorySegments(await db.segments.where("sessionId").equals(state.sessionId).toArray(),history,state);
  if (!segments.length) return finish([],"无有效历史分段");
  const query = resolved.history.slice(-12).map(m => m.rawContent.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")).join("\n").slice(-12000);
  if (!query.trim()) return finish([],"当前剧情为空");
  const topK = Math.max(3,Math.min(5,Math.floor(state.recallTopK || 4)));
  const api = allowEmbedding ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
  if (api && resolveEmbeddingModel(api)) {
    const key = embeddingKey(api);
    const vector = await generateEmbedding(query,api);
    if (validVector(vector)) {
      // Lazily index old/unindexed segments, limiting additional requests per generation.
      for (const s of segments.filter(s => s.embeddingKey !== key || !validVector(s.embedding)).slice(0,5)) {
        const e = await generateEmbedding(s.content,api);
        if (validVector(e)) { s.embedding=e; s.embeddingKey=key; await db.transaction("rw",db.segments,async()=>{const latest=await db.segments.get(s.id);if(latest?.content===s.content&&latest?.editedAt===s.editedAt)await db.segments.put({...latest,embedding:e,embeddingKey:key});}); }
      }
      const ranked = segments.filter(s => s.embeddingKey === key && validVector(s.embedding) && s.embedding.length === vector.length)
        .map(s => ({s,score:cosineSimilarity(vector,s.embedding!)})).filter(s => s.score > 0).sort((a,b)=>b.score-a.score);
      if (ranked.length) { const selected=ranked.slice(0,topK);return finish(selected.map(r=>r.s),"向量召回",selected.map(r=>({id:r.s.id,score:r.score,mode:"vector"}))); }
    }
  }
  const entries: MemoryEntry[] = segments.map(s => ({id:s.id,characterId:state.sessionId,sourceApp:"story",type:"long_term",content:s.content,importance:1,createdAt:s.createdAt,updatedAt:s.createdAt}));
  const hits = keywordSearch(query,entries,topK);
  return finish(hits.map(h => segments.find(s => s.id === h.entry.id)!),hits.length?"关键词召回":"未命中",hits.map(h=>({id:h.entry.id,score:h.score,mode:"keyword"})));
  }catch(error){await finish([],"检索异常（本次未取得结果）");throw error;}
}

/** Read-only sync projection used by the native timeline. Never use this as the
 * authority for deleting or trimming story history. */
export function readStoryMemoryMirror(sessionId: string): StoryMemoryState | null {
  if (!sessionId || typeof localStorage === "undefined") return null;
  try { const raw = localStorage.getItem(`float-story-memory-v3:${sessionId}`); return raw ? JSON.parse(raw) as StoryMemoryState : null; }
  catch { return null; }
}

/** Parse actual XML-like end-of-response tags, not the separate storySummary field. */
export function extractTaggedStorySummary(raw: string): string {
  const matches = [...raw.matchAll(/<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/gi)];
  return matches.length ? matches[matches.length - 1][1].trim() : "";
}

export async function buildInterviewStoryMemory(characterId: string): Promise<string> {
  const { loadStorySessions, loadStoryMessages } = await import("./story-storage");
  const session = loadStorySessions().find(s => s.characterId === characterId);
  if (!session) return "";
  const state = await loadStoryMemory(session.id);
  if (state.interviewEnabled === false) return "";
  const history = loadStoryMessages(session.id);
  const resolved = resolveStoryMemoryContext(history, state);
  // Never use a stale summary after edited/deleted source text.
  const coveredIndex = resolved.valid && state.coveredThroughMessageId
    ? history.findIndex(m => m.id === state.coveredThroughMessageId) : -1;
  const latest = history.filter(m => m.role === "assistant").slice(-Math.max(1, Math.min(20, state.interviewSummaryTurns ?? 6)));
  const lines = latest.filter(m => history.indexOf(m) > coveredIndex).map(m => extractTaggedStorySummary(m.rawContent)).filter(Boolean);
  const parts = [resolved.valid ? `[累计剧情摘要]\n${resolved.summary}` : "", lines.length ? `[最近剧情文末 <summary> 摘要]\n${lines.join("\n\n")}` : ""].filter(Boolean);
  return parts.join("\n\n");
}

/** Hybrid auto trigger. Failed summaries never advance the coverage cursor. */
export async function maybeAutoSummarizeStory(sessionId: string, history: StoryMessage[], apiConfig: ApiConfig): Promise<void> {
  if (!sessionId || activeSummaries.has(sessionId)) return;
  const state = await loadStoryMemory(sessionId);
  if (state.task && state.task.status !== "done") return; // explicit resume, never auto-repeat a refused request
  if (!state.enabled || (state.triggerMode ?? "hybrid") === "manual") return;
  const resolved = resolveStoryMemoryContext(history, state);
  if (state.coveredThroughMessageId && !resolved.valid) return; // stale: manual review required
  const cutoff = cutoffForRecentTurns(history, Math.max(1, state.recentTurns));
  const alreadyCovered = resolved.valid ? history.findIndex(m => m.id === state.coveredThroughMessageId) + 1 : 0;
  const pending = history.slice(alreadyCovered, cutoff);
  if (!pending.length) return;
  const mode = state.triggerMode ?? "hybrid";
  const countHit = pending.length >= Math.max(2, state.triggerMessages ?? 20);
  const tokenHit = estimateTokens(resolved.history.map(m => m.rawContent).join("\n")) >= Math.max(2000, state.triggerTokens);
  if (!((mode === "hybrid" && (countHit || tokenHit)) || (mode === "count" && countHit) || (mode === "tokens" && tokenHit))) return;
  await generateStoryMemorySummary(sessionId, history, state, resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || apiConfig);
}
