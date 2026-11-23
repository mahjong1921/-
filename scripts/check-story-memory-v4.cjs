const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const tables = {};
class Table {
  data = new Map();
  async get(id) { return this.data.get(id); }
  async put(v) { this.data.set(v.id ?? v.sessionId, structuredClone(v)); }
  async bulkPut(vs) { for (const v of vs) await this.put(v); }
  where(key) { return { equals: val => ({ toArray: async () => [...this.data.values()].filter(v => v[key] === val).map(v=>structuredClone(v)) }) }; }
}
class FakeDexie {
  version() { return { stores: schema => { for (const k of Object.keys(schema)) this[k] = tables[k] ??= new Table(); } }; }
  async transaction(_mode,...args) { await args.at(-1)(); }
}
let fail = false, apiCalls = 0, embeddingCalls = 0;
const api = {id:'embedding',provider:'OpenAI',defaultModel:'text-embedding-3-small'};
const mocks = {
  dexie: FakeDexie,
  './api-helpers': {simpleLLMCall: async (_a,[m]) => { apiCalls++; return fail ? {content:''} : {content: m.content.includes('独立剧情分段') ? `segment ${apiCalls}` : `core ${apiCalls}`}; }},
  './token-counter': {estimateTokens: s=>s.length},
  './settings-storage': {resolveAuxiliaryApiConfig:()=>api},
  './memory-embedding': {resolveEmbeddingModel:()=>api.defaultModel,generateEmbedding:async s=>{embeddingCalls++; return s.includes('segment')?[1,0]:[1,0];}, cosineSimilarity:(a,b)=>a[0]*b[0]+a[1]*b[1], keywordSearch:(_q,entries,k)=>entries.slice(0,k).map(entry=>({entry,score:1}))},
};
const file = path.join(__dirname,'../lib/story-memory-manager.ts');
const js = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const mod = {exports:{}};
new Function('require','module','exports',js)(name=>mocks[name]??require(name),mod,mod.exports);
const m = mod.exports;
const history = (session,n) => Array.from({length:n*2},(_,i)=>({id:`${session}-${i}`,sessionId:session,role:i%2?'assistant':'user',rawContent:`event-${i}`,createdAt:new Date(i*1000).toISOString()}));
(async()=>{
  const h=history('A',16), state=m.defaultStoryMemoryState('A');
  assert.equal(state.triggerTokens,20000); assert.equal(state.triggerMessages,20); assert.equal(state.recentTurns,6);
  assert.equal(m.cutoffForRecentTurns(h,6),20);
  assert.equal(m.cutoffForRecentTurns([...h,{id:'pending',sessionId:'A',role:'user',rawContent:'pending'}],6),20);
  await m.saveStoryMemory({...state,enabled:true});
  const saved=await m.loadStoryMemory('A');
  await m.maybeAutoSummarizeStory('A',h,api);
  const generated=await m.loadStoryMemory('A');
  assert.equal(m.resolveStoryMemoryContext(h,generated).history.length,12);
  assert.equal(tables.segments.data.size,1);
  assert.equal((await m.recallStorySegments(h,generated)).length,1);
  assert.ok(embeddingCalls>=2);
  const before=embeddingCalls;
  await m.recallStorySegments(h,generated,false);
  assert.equal(embeddingCalls,before,'preview must not call story embedding');
  const edited=h.map((v,i)=>i===0?{...v,rawContent:'changed'}:v);
  assert.equal(m.resolveStoryMemoryContext(edited,generated).valid,false);
  assert.equal((await m.recallStorySegments(edited,generated)).length,0);
  assert.equal((await m.recallStorySegments(history('B',16),generated)).length,0);
  assert.equal(m.filterStorySegments([...tables.segments.data.values()],h,{...generated,enabled:false}).length,0);
  assert.equal(m.extractTaggedStorySummary('正文<summary>摘要</summary>'),'摘要');
  assert.equal(m.extractTaggedStorySummary('只有正文'),'');
  const more=history('A',26); fail=true;
  await assert.rejects(m.generateStoryMemorySummary('A',more,generated,api));
  assert.equal((await m.loadStoryMemory('A')).coveredDigest,generated.coveredDigest);
  assert.equal(tables.segments.data.size,1);
  await assert.rejects(m.generateStoryMemorySummary('A',more,saved,api));
  console.log('story memory v4: hybrid, full turns, persistence, recall, preview, stale data, isolation, failure and concurrent state checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
