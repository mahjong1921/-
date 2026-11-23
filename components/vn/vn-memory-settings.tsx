"use client";
import {MemoryWorkspace} from "../story/memory-workspace";
import {vnMemoryHistory,vnMemoryId} from "@/lib/vn-memory-manager";
import {loadVnMessages} from "@/lib/vn-storage";
import {loadApiConfigs,loadBindingConfig,resolveBinding,resolveAuxiliaryApiConfig} from "@/lib/settings-storage";

export function VnMemorySettings({sessionId,characterId,onClose}:{sessionId:string;characterId:string;onClose:()=>void}) {
  return <MemoryWorkspace key={sessionId} sessionId={vnMemoryId(sessionId)} mode="vn" getHistory={()=>vnMemoryHistory(loadVnMessages(sessionId))} getFallbackApi={()=>{const bound=resolveBinding(loadBindingConfig(),characterId,"vn");return resolveAuxiliaryApiConfig("memorySummaryApiConfigId")||loadApiConfigs().find(c=>c.id===bound.apiConfigId);}} onClose={onClose}/>;
}
