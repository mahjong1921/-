import type { VnMessage } from "./vn-types";
import type { ApiConfig } from "./settings-types";
import { loadVnMessages,loadVnSessions } from "./vn-storage";
import { cutoffForRecentTurns,generateStoryMemorySummary,loadStoryMemory,maybeAutoSummarizeStory,readStoryMemoryMirror,resolveStoryMemoryContext,recallStorySegments,isMemoryRunning,storyCoveredDigest } from "./story-memory-manager";
import { resolveAuxiliaryApiConfig } from "./settings-storage";

export const vnMemoryId=(sessionId:string)=>`vn:${sessionId}`;
export const vnMemoryHistory=(history:VnMessage[])=>{
  const session=loadVnSessions().find(s=>s.id===history[0]?.sessionId);
  const archived=new Map<string,{content:string;endId:string}>();
  for(const ch of session?.chapters??[]) {
    const chapter=history.filter(m=>m.chapterIndex===ch.index);
    if(ch.archived&&ch.summaryContent&&ch.summaryDigest&&chapter.length&&chapter.at(-1)?.id===ch.endMessageId&&storyCoveredDigest(chapter)===ch.summaryDigest)archived.set(chapter[0].id,{content:ch.summaryContent,endId:chapter.at(-1)!.id});
  }
  return history.map(m=>({...m,sessionId:vnMemoryId(m.sessionId),archivedSummary:archived.get(m.id)}));
};

export async function maybeAutoSummarizeVn(characterId:string,history:VnMessage[],api:ApiConfig) {
  const session=loadVnSessions().find(s=>s.characterId===characterId&&s.id===history[0]?.sessionId);
  if(!session)return;
  const id=vnMemoryId(session.id), messages=vnMemoryHistory(history), state=await loadStoryMemory(id);
  if(!state.enabled||state.triggerMode==="manual"||isMemoryRunning(id)||(state.task&&state.task.status!=="done"))return;
  const resolved=resolveStoryMemoryContext(messages,state);
  if(state.coveredThroughMessageId&&!resolved.valid)return;
  const cutoff=cutoffForRecentTurns(messages,state.recentTurns);
  const covered=resolved.valid?messages.findIndex(m=>m.id===state.coveredThroughMessageId)+1:0;
  const archivedPending=history.slice(covered,cutoff).some(m=>session.chapters[m.chapterIndex]?.archived);
  if(archivedPending)await generateStoryMemorySummary(id,messages,state,resolveAuxiliaryApiConfig("memorySummaryApiConfigId")||api);
  else await maybeAutoSummarizeStory(id,messages,api);
}

export async function resolveVnMemory(history:VnMessage[],allowEmbedding:boolean) {
  if(!history.length)return {history,summary:"",recalled:[]};
  const state=await loadStoryMemory(vnMemoryId(history[0].sessionId));
  const adapted=vnMemoryHistory(history), resolved=resolveStoryMemoryContext(adapted,state);
  const recalled=await recallStorySegments(adapted,state,allowEmbedding).catch(()=>[]);
  return {history:resolved.valid?history.slice(history.length-resolved.history.length):history,summary:resolved.summary,recalled};
}

/** Cross-scene projection is intentionally lightweight. No VN raw frame text. */
export function readVnCrossSceneMemory(characterId:string) {
  const session=loadVnSessions().find(s=>s.characterId===characterId);
  if(!session)return null;
  const state=readStoryMemoryMirror(vnMemoryId(session.id));
  if(!state)return null;
  const history=loadVnMessages(session.id), resolved=resolveStoryMemoryContext(vnMemoryHistory(history),state);
  if(!resolved.valid)return null;
  const covered=history.findIndex(m=>m.id===state.coveredThroughMessageId);
  const recent=session.chapters.filter(ch=>ch.archived&&ch.summaryContent&&history.findIndex(m=>m.id===ch.startMessageId)>covered).slice(-6);
  return [{id:`vn_memory_${session.id}`,timestamp:history[covered].createdAt,content:`[漫卷累计记忆] ${resolved.summary}`},...recent.map(ch=>({id:`vn_memory_chapter_${ch.id}`,timestamp:ch.summaryTimestamp||session.updatedAt,content:`[漫卷章节摘要] ${ch.summaryContent}`}))];
}
