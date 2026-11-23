"use client";
import { useEffect, useState } from "react";
import { getMemoryRecallHits, isMemoryRunning, listStorySegments, loadStoryMemory, requestMemoryPause, supplyMemoryDraft, type StoryMemoryState, type StorySegment, type RecallHit } from "@/lib/story-memory-manager";

export function MemoryTaskPanel({sessionId,onChanged}:{sessionId:string;onChanged?:()=>void}) {
  const [state,setState]=useState<StoryMemoryState|null>(null);
  const [segments,setSegments]=useState<StorySegment[]>([]);
  const [hits,setHits]=useState<RecallHit[]>([]);
  const [running,setRunning]=useState(false);
  const [manual,setManual]=useState("");
  useEffect(()=>{
    let alive=true;
    const refresh=async()=>{try{const [s,list]=await Promise.all([loadStoryMemory(sessionId),listStorySegments(sessionId)]);if(alive){setState(s);setSegments(list);setHits(getMemoryRecallHits(sessionId));setRunning(isMemoryRunning(sessionId));}}catch{}};
    void refresh(); const timer=setInterval(refresh,1500); return()=>{alive=false;clearInterval(timer);};
  },[sessionId]);
  const task=state?.task;
  return <section style={{display:"grid",gap:8,border:"1px solid #aaa5",borderRadius:8,padding:10}}>
    <strong>溯章 · 任务与分段记忆</strong>
    {task && <><span>{running ? "运行中" : task.status === "running" ? "已中断，可继续" : ({paused:"暂停",failed:"失败",done:"完成"} as const)[task.status]} · {task.completed}/{task.total} · {task.stage}</span><progress max={Math.max(1,task.total)} value={task.completed} style={{width:"100%"}}/><small>用时 {Math.max(0,Math.floor((Date.now()-Date.parse(task.startedAt))/1000))} 秒（含暂停时间）</small>{task.error&&<div role="alert" style={{color:"#b34",overflowWrap:"anywhere"}}>{task.error}</div>}{running&&<button onClick={()=>requestMemoryPause(sessionId)}>当前 API 返回后暂停</button>}{!running&&task.draft&&task.status!=="done"&&<details><summary>手动补充失败分段</summary><small>填写该分段完整、合规的摘要，随后点击继续任务。</small><textarea value={manual} rows={4} onChange={e=>setManual(e.target.value)} style={{width:"100%"}}/><button onClick={async()=>{try{await supplyMemoryDraft(sessionId,manual);setManual("");onChanged?.();}catch(e){alert(String(e));}}}>保存手动摘要</button></details>}</>}
    <details><summary>已保存历史分段（{segments.length}）</summary>{segments.map(s=>{const hit=hits.find(h=>h.id===s.id);return <details key={s.id} style={{marginBlock:8}}><summary>{new Date(s.createdAt).toLocaleString()} · {s.embedding?.length?"已索引":"待索引"}{hit?` · ${hit.mode} ${hit.score.toFixed(3)}`:""}</summary><small>{s.firstId} → {s.lastId}</small><p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{s.content}</p></details>})}</details>
    <small>本页最近一次正式召回：{hits.length} 段；预览不会改写真实命中记录。</small>
  </section>;
}
