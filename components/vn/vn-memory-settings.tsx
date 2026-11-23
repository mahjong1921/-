"use client";
import { useEffect,useState } from "react";
import { MemoryTaskPanel } from "../story/memory-task-panel";
import { DEFAULT_SEGMENT_PROMPT,DEFAULT_STORY_SUMMARY_PROMPT,generateStoryMemorySummary,isMemoryRunning,loadStoryMemory,saveStoryMemory,type StoryMemoryState } from "@/lib/story-memory-manager";
import { vnMemoryHistory,vnMemoryId } from "@/lib/vn-memory-manager";
import { loadVnMessages } from "@/lib/vn-storage";
import { resolveVnConfigs } from "@/lib/vn-engine";
import { loadApiConfigs,resolveAuxiliaryApiConfig } from "@/lib/settings-storage";

export function VnMemorySettings({sessionId,characterId,onClose}:{sessionId:string;characterId:string;onClose:()=>void}) {
  const id=vnMemoryId(sessionId);
  const [state,setState]=useState<StoryMemoryState|null>(null),[busy,setBusy]=useState(false),[running,setRunning]=useState(false);
  const refresh=()=>loadStoryMemory(id).then(setState);
  useEffect(()=>{let alive=true;let previous=false;const tick=()=>{const now=isMemoryRunning(id);setRunning(now);if(previous&&!now)void loadStoryMemory(id).then(s=>{if(alive)setState(s);});previous=now;};void loadStoryMemory(id).then(s=>{if(alive)setState(s);});const timer=setInterval(tick,500);return()=>{alive=false;clearInterval(timer);};},[id]);
  const run=async()=>{if(!state||!confirm("将调用摘要 API 整理历史漫卷，可能产生费用。继续？"))return;setBusy(true);try{const api=resolveAuxiliaryApiConfig("memorySummaryApiConfigId")||resolveVnConfigs(characterId).apiConfig;await generateStoryMemorySummary(id,vnMemoryHistory(loadVnMessages(sessionId)),state,api);}catch(e){alert(e instanceof Error?e.message:String(e));}finally{await refresh();setBusy(false);}};
  if(!state)return null;
  const disabled=busy||running;
  const field=(key:"summaryPrompt"|"segmentPrompt"|"supplementalPrompt",label:string,value:string)=> <details><summary>{label}</summary><textarea rows={7} style={{width:"100%"}} value={state[key]??value} disabled={disabled} onChange={e=>setState({...state,[key]:e.target.value})}/><button disabled={disabled} onClick={()=>setState({...state,[key]:value})}>恢复默认</button></details>;
  return <div style={{position:"fixed",inset:0,zIndex:10000,background:"#0008",display:"grid",placeItems:"center",padding:16}}><div style={{background:"#fffdf9",color:"#34312e",borderRadius:12,padding:16,width:"100%",maxWidth:560,maxHeight:"88vh",overflowY:"auto",display:"grid",gap:10}}>
    <div style={{display:"flex",justifyContent:"space-between"}}><strong>溯章 · 漫卷记忆</strong><button onClick={onClose}>关闭 ✕</button></div>
    <MemoryTaskPanel sessionId={id} onChanged={()=>void refresh()}/>
    <label>摘要模型绑定 <select disabled={disabled} value={state.summaryApiConfigId??""} onChange={e=>setState({...state,summaryApiConfigId:e.target.value||undefined})}><option value="">辅助记忆总结 API（未设置则漫卷 API）</option>{loadApiConfigs().map(c=><option key={c.id} value={c.id}>{c.name||c.defaultModel} · {c.defaultModel}</option>)}</select></label>
    <label><input disabled={disabled} type="checkbox" checked={state.enabled} onChange={e=>setState({...state,enabled:e.target.checked})}/> 启用漫卷摘要压缩</label>
    <label>触发模式 <select disabled={disabled} value={state.triggerMode??"hybrid"} onChange={e=>setState({...state,triggerMode:e.target.value as StoryMemoryState["triggerMode"]})}><option value="hybrid">混合</option><option value="count">消息数</option><option value="tokens">Token</option><option value="manual">手动</option></select></label>
    <label>保留轮数 <input disabled={disabled} type="number" min={2} max={30} value={state.recentTurns} onChange={e=>setState({...state,recentTurns:Math.max(2,Math.min(30,Number(e.target.value)||6))})}/></label>
    <label>消息阈值 <input disabled={disabled} type="number" min={2} value={state.triggerMessages??20} onChange={e=>setState({...state,triggerMessages:Math.max(2,Number(e.target.value)||20)})}/></label>
    <label>Token 阈值 <input disabled={disabled} type="number" min={2000} value={state.triggerTokens} onChange={e=>setState({...state,triggerTokens:Math.max(2000,Number(e.target.value)||20000)})}/></label>
    <label><input disabled={disabled} type="checkbox" checked={state.recallEnabled!==false} onChange={e=>setState({...state,recallEnabled:e.target.checked})}/> 相关分段检索</label>
    <label>召回数量 <select disabled={disabled} value={state.recallTopK??4} onChange={e=>setState({...state,recallTopK:Number(e.target.value)})}>{[3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>
    {field("segmentPrompt","分段摘要提示词",DEFAULT_SEGMENT_PROMPT)}{field("summaryPrompt","累计摘要提示词",DEFAULT_STORY_SUMMARY_PROMPT)}{field("supplementalPrompt","独立补充指令","")}
    <label>补充指令注入位置 <select disabled={disabled} value={state.supplementalPosition??"after"} onChange={e=>setState({...state,supplementalPosition:e.target.value as "before"|"after"})}><option value="before">模板之前</option><option value="after">模板之后、素材之前</option></select></label>
    <details><summary>累计摘要</summary><p style={{whiteSpace:"pre-wrap"}}>{state.summaryText||"尚未生成"}</p></details>
    <button disabled={disabled} onClick={async()=>{try{await saveStoryMemory(state,"manual",[],state);await refresh();}catch(e){alert(String(e));}}}>保存设置</button><button disabled={disabled} onClick={()=>void run()}>{disabled?"整理中…":state.task&&state.task.status!=="done"?"继续 / 重试":"生成 / 更新摘要"}</button>
  </div></div>;
}
