import Dexie from "dexie";
import type { StoryMessage } from "./story-storage";
import type { ApiConfig } from "./settings-types";
import { simpleLLMCall } from "./api-helpers";
import { estimateTokens } from "./token-counter";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity, keywordSearch } from "./memory-embedding";
import type { MemoryEntry } from "./memory-types";

export const DEFAULT_STORY_SUMMARY_PROMPT = `你是长期互动剧情的连续性记忆整理助手。你的任务是根据旧记忆和新增剧情更新累计摘要，而不是续写剧情。严格区分已明确发生的事实、角色明确表达的想法和根据言行推测的心理；不杜撰、不美化、不改变人物性格。

请按照以下结构输出，优先保留会影响后续人物选择和关系发展的信息：
【时间与场景】时间顺序、地点、场景切换、当前时间地点和在场人物。
【关键事件与因果】重要行动、决定、冲突、结果及其因果联系。
【人物关系与边界】关系阶段、亲密程度、权力动态、信任变化、承诺和边界。
【情感节点】情绪转折的触发事件、双方反应、情感意义、未说出口但有明确行为依据的张力。
【心理状态】各角色当前需求、恐惧、矛盾、期待、防御机制；对推断标注“可能/暗示”，不可当作确定事实。
【人物动向】当前目标、计划、态度变化、主动或回避的倾向，以及下一步可能影响行动的动机。
【伏笔与关键细节】秘密、重要物品、未解决问题、约定、具有后续意义的原话和细节。
【当前剧情衔接点】最后发生的动作、对话与未完成的即时互动。

摘要应具体、准确、结构化，避免空泛评价和重复修辞。保留旧记忆中仍有效的重要信息，并整合新增剧情；如新事实推翻旧状态，以最新明确事实为准。尽量控制在2500中文字以内。`;

export type StoryMemoryState = {
  sessionId: string;
  enabled: boolean;
  summaryText: string;
  summaryPrompt?: string;
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
export type StorySegment = { id: string; sessionId: string; firstId: string; lastId: string; digest: string; content: string; createdAt: string; embedding?: number[]; embeddingKey?: string };
class StoryMemoryDB extends Dexie {
  states!: Dexie.Table<StoryMemoryState, string>;
  revisions!: Dexie.Table<StoryMemoryRevision, string>;
  segments!: Dexie.Table<StorySegment, string>;
  constructor() { super("AiPhoneStoryMemoryDB"); this.version(1).stores({ states: "sessionId", revisions: "id, sessionId, createdAt" }); this.version(2).stores({ states: "sessionId", revisions: "id, sessionId, createdAt", segments: "id, sessionId" }); }
}
const db = new StoryMemoryDB();
export function defaultStoryMemoryState(sessionId: string): StoryMemoryState {
  return { sessionId, enabled: false, summaryText: "", summaryPrompt: DEFAULT_STORY_SUMMARY_PROMPT, coveredThroughMessageId: null, coveredDigest: "", recentTurns: 6, triggerTokens: 20000, triggerMode: "hybrid", triggerMessages: 20, interviewEnabled: true, interviewSummaryTurns: 6, crossStoryToChat: "summary-recent", crossChatToStory: "full", crossMoments: "summary-recent", updatedAt: new Date().toISOString() };
}
export async function loadStoryMemory(sessionId: string): Promise<StoryMemoryState> {
  const state = (await db.states.get(sessionId)) ?? defaultStoryMemoryState(sessionId);
  // Migrate v2 IndexedDB state to the read-only cross-scene mirror on first access.
  if (typeof localStorage !== "undefined" && sessionId) {
    try { localStorage.setItem(`float-story-memory-v3:${sessionId}`, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }
  return state;
}
export async function saveStoryMemory(state: StoryMemoryState, source: StoryMemoryRevision["source"] = "manual", segments: StorySegment[] = [], expected?: StoryMemoryState | null): Promise<void> {
  const next = { ...state, updatedAt: new Date().toISOString() };
  await db.transaction("rw", db.states, db.revisions, db.segments, async () => {
    const stored = await db.states.get(next.sessionId);
    if (expected !== undefined && (stored ? stored.updatedAt !== expected?.updatedAt : Boolean(expected?.coveredThroughMessageId))) throw new Error("剧情记忆已被其他操作更新，请重新加载后再试。");
    await db.states.put(next);
    if (segments.length) await db.segments.bulkPut(segments);
    await db.revisions.put({ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, sessionId: next.sessionId, summaryText: next.summaryText, coveredThroughMessageId: next.coveredThroughMessageId, coveredDigest: next.coveredDigest, source, createdAt: next.updatedAt });
  });
  // A synchronous read-through mirror for the shared short-term timeline.
  // The IndexedDB state remains authoritative; the mirror is only a projection.
  if (typeof localStorage !== "undefined") {
    try { localStorage.setItem(`float-story-memory-v3:${next.sessionId}`, JSON.stringify(next)); } catch { /* private browsing/quota */ }
  }
}
export async function listStoryMemoryRevisions(sessionId: string): Promise<StoryMemoryRevision[]> {
  return (await db.revisions.where("sessionId").equals(sessionId).toArray()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
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
  if (!sessionId || current.sessionId !== sessionId || history.some(m => m.sessionId !== sessionId)) throw new Error("剧情会话不一致。");
  const expected = await db.states.get(sessionId);
  if (expected && expected.updatedAt !== current.updatedAt) throw new Error("剧情记忆已有更新，请重新打开管理页面。");
  const cutoff = cutoffForRecentTurns(history, Math.max(1,current.recentTurns));
  if (cutoff===0) throw new Error("剧情不足以压缩：需要更多历史对话。");
  const previous = resolveStoryMemoryContext(history,{...current,enabled:true});
  // If old coverage is stale, rebuild from the current source; old segments
  // remain inaccessible unless their exact original source range still matches.
  const oldCovered = previous.valid ? history.findIndex(m=>m.id===current.coveredThroughMessageId)+1 : 0;
  const pending = history.slice(oldCovered,cutoff);
  if (!pending.length) throw new Error("目前没有新的可压缩剧情。");
  let rolling = previous.valid ? previous.summary : "";
  const batches: {text:string; messages:StoryMessage[]}[] = [];
  let chunk = "";
  let chunkMessages: StoryMessage[] = [];
  const flush = () => { if (chunk) batches.push({text:chunk,messages:chunkMessages}); chunk=""; chunkMessages=[]; };
  for (const msg of pending) {
    // Prefer model-produced end-of-chapter summary; preserve user actions verbatim.
    const body = msg.role==="assistant" && msg.storySummary?.trim() ? msg.storySummary.trim() : msg.rawContent;
    const line = `[${msg.role === "user" ? "用户" : msg.role === "assistant" ? "角色" : "系统"}] ${body}
`;
    if (chunk && (estimateTokens(chunk+line)>5500 || chunkMessages.length >= 20)) flush();
    if (estimateTokens(line)>5500) {
      // Long single message: split without skipping its content.
      for (let pos=0;pos<line.length;pos+=6000) batches.push({text:line.slice(pos,pos+6000),messages:[msg]});
    } else { chunk+=line; chunkMessages.push(msg); }
  }
  flush();
  const independent = new Map<string, StorySegment>();
  for (let i=0;i<batches.length;i++) {
    const batch = batches[i];
    const segmentResult = await simpleLLMCall(apiConfig,[{role:"user",content:`${current.summaryPrompt?.trim() || DEFAULT_STORY_SUMMARY_PROMPT}\n\n【独立剧情分段】仅总结下面这段，不加入旧记忆；保留可检索的人物、地点、事件、伏笔。\n${batch.text}`}],{temperature:0.2,label:`独立剧情分段 ${i+1}/${batches.length}`});
    if (!segmentResult.content?.trim() || segmentResult.wasTruncated) throw new Error("独立分段摘要失败，旧记忆保持不变。");
    const firstId=batch.messages[0].id,lastId=batch.messages[batch.messages.length-1].id,digest=storyCoveredDigest(batch.messages);
    const id=JSON.stringify([sessionId,firstId,lastId,digest]);
    const existing=independent.get(id);
    if (existing) existing.content += "\n\n"+segmentResult.content.trim();
    else independent.set(id,{id,sessionId,firstId,lastId,digest,content:segmentResult.content.trim(),createdAt:new Date().toISOString()});
    const prompt = `${current.summaryPrompt?.trim() || DEFAULT_STORY_SUMMARY_PROMPT}\n\n【旧记忆】\n${rolling || "（无）"}\n【新增剧情 ${i+1}/${batches.length}】\n${batch.text}`;
    const result = await simpleLLMCall(apiConfig,[{role:"user",content:prompt}],{temperature:0.2,label:`剧情记忆压缩 ${i+1}/${batches.length}`});
    if (!result.content?.trim() || result.wasTruncated) throw new Error(result.error || `第 ${i+1} 段摘要生成失败或截断，旧记忆保持不变。`);
    rolling=result.content.trim();
  }
  const next: StoryMemoryState = { ...current, enabled:true, summaryText:rolling, coveredThroughMessageId:history[cutoff-1].id, coveredDigest:storyCoveredDigest(history.slice(0,cutoff)), updatedAt:new Date().toISOString() };
  const segments = [...independent.values()];
  const embeddingApi = current.recallEnabled === false ? null : resolveAuxiliaryApiConfig("embeddingApiConfigId");
  if (embeddingApi && resolveEmbeddingModel(embeddingApi)) for (const segment of segments) {
    const vector = await generateEmbedding(segment.content, embeddingApi);
    if (validVector(vector)) { segment.embedding = vector; segment.embeddingKey = embeddingKey(embeddingApi); }
  }
  await saveStoryMemory(next,"auto",segments,expected ?? null);
  return loadStoryMemory(sessionId);
}

function embeddingKey(api: ApiConfig): string { return JSON.stringify([api.id,api.provider,api.baseUrl,resolveEmbeddingModel(api)]); }
function validVector(vector: number[] | null | undefined): vector is number[] { return !!vector?.length && vector.every(Number.isFinite) && vector.some(v => v !== 0); }

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
  if (state.recallEnabled === false || !state.sessionId) return [];
  const resolved = resolveStoryMemoryContext(history,state);
  if (!resolved.valid) return [];
  const segments = filterStorySegments(await db.segments.where("sessionId").equals(state.sessionId).toArray(),history,state);
  if (!segments.length) return [];
  const query = resolved.history.slice(-12).map(m => m.rawContent.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")).join("\n").slice(-12000);
  if (!query.trim()) return [];
  const topK = Math.max(3,Math.min(5,Math.floor(state.recallTopK || 4)));
  const api = allowEmbedding ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
  if (api && resolveEmbeddingModel(api)) {
    const key = embeddingKey(api);
    const vector = await generateEmbedding(query,api);
    if (validVector(vector)) {
      // Lazily index old/unindexed segments, limiting additional requests per generation.
      for (const s of segments.filter(s => s.embeddingKey !== key || !validVector(s.embedding)).slice(0,5)) {
        const e = await generateEmbedding(s.content,api);
        if (validVector(e)) { s.embedding=e; s.embeddingKey=key; await db.segments.put(s); }
      }
      const ranked = segments.filter(s => s.embeddingKey === key && validVector(s.embedding) && s.embedding.length === vector.length)
        .map(s => ({s,score:cosineSimilarity(vector,s.embedding!)})).filter(s => s.score > 0).sort((a,b)=>b.score-a.score);
      if (ranked.length) return ranked.slice(0,topK).map(r=>r.s);
    }
  }
  const entries: MemoryEntry[] = segments.map(s => ({id:s.id,characterId:state.sessionId,sourceApp:"story",type:"long_term",content:s.content,importance:1,createdAt:s.createdAt,updatedAt:s.createdAt}));
  const hits = keywordSearch(query,entries,topK);
  return hits.map(h => segments.find(s => s.id === h.entry.id)!);
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

const activeSummaries = new Set<string>();
/** Hybrid auto trigger. Failed summaries never advance the coverage cursor. */
export async function maybeAutoSummarizeStory(sessionId: string, history: StoryMessage[], apiConfig: ApiConfig): Promise<void> {
  if (!sessionId || activeSummaries.has(sessionId)) return;
  const state = await loadStoryMemory(sessionId);
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
  activeSummaries.add(sessionId);
  try { await generateStoryMemorySummary(sessionId, history, state, apiConfig); }
  finally { activeSummaries.delete(sessionId); }
}
