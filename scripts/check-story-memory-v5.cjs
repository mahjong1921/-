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
  constructor(name){this.name=name;}
  version() { return { stores: schema => { for (const k of Object.keys(schema)) this[k] = tables[`${this.name}:${k}`] ??= new Table(); } }; }
  async transaction(_mode,...args) { await args.at(-1)(); }
}
let fail = false, failAt=0, apiCalls = 0, embeddingCalls = 0, requests=[], pauseAt=0;
const api = {id:'embedding',provider:'OpenAI',defaultModel:'text-embedding-3-small'};
const mocks = {
  dexie: FakeDexie,
  './api-helpers': {simpleLLMCall: async (_a,msgs) => { apiCalls++; requests.push(msgs); if(apiCalls===pauseAt)m.requestMemoryPause('P'); return fail||apiCalls===failAt ? {content:'',error:'API 451 code 20021'} : {content: msgs.at(-1).content.includes('独立剧情分段') ? `segment ${apiCalls}` : `core ${apiCalls}`}; }},
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
  assert.equal((await m.listStorySegments('A')).length,1);
  assert.equal((await m.recallStorySegments(h,generated)).length,1);
  assert.ok(embeddingCalls>=2);
  const before=embeddingCalls;
  await m.recallStorySegments(h,generated,false);
  assert.equal(embeddingCalls,before,'preview must not call story embedding');
  const edited=h.map((v,i)=>i===0?{...v,rawContent:'changed'}:v);
  assert.equal(m.resolveStoryMemoryContext(edited,generated).valid,false);
  assert.equal((await m.recallStorySegments(edited,generated)).length,0);
  assert.equal((await m.recallStorySegments(history('B',16),generated)).length,0);
  assert.equal(m.filterStorySegments(await m.listStorySegments('A'),h,{...generated,enabled:false}).length,0);
  assert.equal(m.extractTaggedStorySummary('正文<summary>摘要</summary>'),'摘要');
  assert.equal(m.extractTaggedStorySummary('只有正文'),'');
  const more=history('A',26); fail=true;
  await assert.rejects(m.generateStoryMemorySummary('A',more,generated,api));
  assert.equal((await m.loadStoryMemory('A')).coveredDigest,generated.coveredDigest);
  assert.equal((await m.listStorySegments('A')).length,1);
  await assert.rejects(m.generateStoryMemorySummary('A',more,saved,api));
  fail=false;
  const b=history('B',36), bs={...m.defaultStoryMemoryState('B'),enabled:true,segmentPrompt:'SEG',summaryPrompt:'CORE',supplementalPrompt:'EXTRA',supplementalPosition:'before'};
  await m.saveStoryMemory(bs); failAt=apiCalls+4; // first segment fully committed; second independent generated, core fails
  await assert.rejects(m.generateStoryMemorySummary('B',b,await m.loadStoryMemory('B'),api),/451/);
  const paused=await m.loadStoryMemory('B');
  assert.equal(paused.task.status,'failed'); assert.equal(paused.task.completed,1);assert.equal(paused.task.draft.parts.length,1);
  assert.equal((await m.listStorySegments('B')).length,1);
  assert.equal(m.resolveStoryMemoryContext(b,paused).history.length,52);
  const callsBefore=apiCalls; await m.maybeAutoSummarizeStory('B',b,api); assert.equal(apiCalls,callsBefore);
  failAt=0; const resumed=await m.generateStoryMemorySummary('B',b,paused,api);
  assert.equal(resumed.task.completed,3); assert.equal(resumed.task.status,'done'); assert.equal(apiCalls-callsBefore,3,'reuse second independent result and first committed group');
  assert.equal((await m.listStorySegments('B')).length,3);
  assert.equal(requests.find(r=>r[0].content.includes('SEG'))[0].content,'EXTRA\n\nSEG');
  assert.equal(requests.find(r=>r[0].content.includes('CORE'))[0].content,'EXTRA\n\nCORE');
  const v=history('vn:A',16); await m.generateStoryMemorySummary('vn:A',v,m.defaultStoryMemoryState('vn:A'),api);
  assert.equal((await m.listStorySegments('vn:A')).length,1); assert.equal((await m.listStorySegments('A')).length,1);
  assert.ok(tables['AiPhoneVnMemoryDB:segments']);
  const c=history('C',26); await m.saveStoryMemory({...m.defaultStoryMemoryState('C'),enabled:true,supplementalPrompt:'POST',supplementalPosition:'after'});
  failAt=apiCalls+1; await assert.rejects(m.generateStoryMemorySummary('C',c,await m.loadStoryMemory('C'),api));
  await m.supplyMemoryDraft('C','人工提供的完整合规摘要');
  failAt=0; const beforeManual=apiCalls;
  await m.generateStoryMemorySummary('C',c,await m.loadStoryMemory('C'),api);
  assert.equal(apiCalls-beforeManual,3,'manual draft avoids one independent request');
  assert.ok(requests.some(r=>r[0].content.endsWith('\n\nPOST')));
  const p=history('P',16); pauseAt=apiCalls+1;
  const stopped=await m.generateStoryMemorySummary('P',p,m.defaultStoryMemoryState('P'),api);
  assert.equal(stopped.task.status,'paused');assert.equal(stopped.task.draft.parts.length,1);assert.equal(stopped.coveredThroughMessageId,null);
  const beforePause=apiCalls; await m.generateStoryMemorySummary('P',p,stopped,api);assert.equal(apiCalls-beforePause,1);
  const archived=history('vn:archived',16); archived[0].archivedSummary={content:'已有已校验的完整章节摘要',endId:archived[19].id};
  const beforeArchived=apiCalls;await m.generateStoryMemorySummary('vn:archived',archived,m.defaultStoryMemoryState('vn:archived'),api);
  assert.equal(apiCalls-beforeArchived,1);assert.equal((await m.listStorySegments('vn:archived'))[0].content,'已有已校验的完整章节摘要');
  const moduleJs=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/data-management/modules.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const moduleExports={exports:{}};new Function('module','exports',moduleJs)(moduleExports,moduleExports.exports);
  const backupMemory=moduleExports.exports.DATA_MODULES.find(x=>x.id==='memory');
  for(const dbName of ['AiPhoneStoryMemoryDB','AiPhoneVnMemoryDB'])assert.ok(backupMemory.sources.some(s=>s.type==='indexeddb'&&s.dbName===dbName));
  console.log('v5: hybrid, coverage, recall, preview, failure checkpoints, resume, instruction position, VN isolation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
