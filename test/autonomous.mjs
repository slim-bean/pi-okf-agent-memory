import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, realpathSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { jiti } from './loader.mjs';
import { createHarness } from './support.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const {resolveOkfBin,default:extension}=await jiti.import(join(root,'index.ts'));
const {registerMemoryMaintenance}=await jiti.import(join(root,'lib/maintenance.ts'));
const {validateBundle}=await jiti.import(join(root,'lib/okf.ts'));
const {configuredOwnership}=await jiti.import(join(root,'lib/ownership.ts'));
const binary=resolveOkfBin();
process.env.GIT_CONFIG_GLOBAL='/dev/null';process.env.GIT_CONFIG_NOSYSTEM='1';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const cli=(...args)=>execFileSync(binary,args,{encoding:'utf8'});
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'});
const tool=(name,args,id)=>({stopReason:'toolUse',content:[{type:'toolCall',name,arguments:args,id:id??`${name}-${Math.random()}`}]});
const stop=text=>({stopReason:'stop',content:[{type:'text',text}]});
function fixture({missing=false}={}) {
  const cwd=realpathSync(mkdtempSync(join(tmpdir(),'okf-full-')));const bundle=join(cwd,'knowledge');
  if(!missing){cli('init',bundle);git(bundle,'init','--quiet');git(bundle,'config','user.name','Offline Agent');git(bundle,'config','user.email','agent@example.invalid');git(bundle,'config','commit.gpgsign','false');}
  const bus=new EventEmitter();const hooks=new Map();let calls=0;let sequence=[];const prompts=[];const events=[];
  const model={provider:'fake',id:'offline',contextWindow:200000,maxTokens:8192};
  const ctx={cwd,model,modelRegistry:{find:()=>model,hasConfiguredAuth:()=>true,streamSimple(_model,input){
    calls++;assert.match(input.systemPrompt,/UNTRUSTED/);prompts.push(input);
    const next=sequence.shift();const value=typeof next==='function'?next(input):next;
    const response={role:'assistant',api:'openai-responses',provider:'fake',model:'offline',timestamp:Date.now(),usage:{cost:{total:.01}},
      ...(value??stop(JSON.stringify({reviewed:true,changes:[]})))};
    return {result:async()=>response};
  }}};
  const adapter=registerMemoryMaintenance({events:bus,on:(n,f)=>hooks.set(n,f)}, {packageVersion:'0.5.0',skillsDir:join(root,'skills'),getBinary:()=>binary,busy:()=>false});
  const entries=[{index:1,id:'a',parentId:null,timestampMs:1,role:'user',text:'Retain verified rationale, but qualify uncertainty rather than waiting for a human.'}];
  const source={path:join(cwd,'source.jsonl'),cwd,hash:hash(entries),entries};writeFileSync(source.path,JSON.stringify(source)+'\n');
  const run=async(operation,extra={})=>{const r={protocol:1,operation,cwd,context:ctx,source,workDir:join(cwd,'work'),memoryOwnership:'full',assertSource(){},onEvent:(type,detail)=>events.push({type,detail}),...extra};bus.emit('okf:maintenance:v1',r);return r.result;};
  return {cwd,bundle,ctx,run,events,prompts,set sequence(v){sequence=v},get calls(){return calls},async close(){await adapter.stop();rmSync(cwd,{recursive:true,force:true})}};
}
function seedInvalid(f) {
  cli('create','decision',f.bundle,'--type','Decision','--title','Rationale','--desc','Rationale with review evidence.','--body','Earlier claim needs evidence review.');
  const path=join(f.bundle,'decision.md');const original=readFileSync(path,'utf8');
  writeFileSync(path,original.replace('---\n','---\ngovernance: invalid\nstale_after: 2000-01-01\n'));
  writeFileSync(join(f.cwd,'evidence.txt'),'Repository evidence: the earlier rationale was a proposal, not an established fact.\n');
  return {path,original};
}
function evidenceRepair(f) {
  return [tool('read',{path:'../evidence.txt'}),tool('edit',{path:'decision.md',edits:[
    {oldText:'governance: invalid\nstale_after: 2000-01-01\n',newText:'governance: context\n'},
    {oldText:'Earlier claim needs evidence review.',newText:'Historical proposal, not an established fact. Repository evidence does not establish implementation; retain only this qualified rationale.'},
  ]}),stop('Reviewed repository evidence, corrected malformed governance and qualified the historical claim. No human verification is asserted.')];
}

test('ownership defaults to limited without host autodetection; generic explicit policy wins',()=>{
  const env={...process.env};const cwd=mkdtempSync(join(tmpdir(),'ownership-'));
  try {
    delete process.env.PI_MEMORY_OWNERSHIP;
    process.env.HOST_WORKSPACE_PATH='/workspace';process.env.SANDBOX_NAME='worker';
    assert.equal(configuredOwnership(cwd),'limited');
    process.env.PI_MEMORY_OWNERSHIP='full';assert.equal(configuredOwnership(cwd),'full');assert.equal(configuredOwnership(cwd,'limited'),'limited');
    process.env.PI_MEMORY_OWNERSHIP='limited';assert.equal(configuredOwnership(cwd,'full'),'full');
    assert.throws(()=>configuredOwnership(cwd,'guess'),/limited or full/);
  }finally{process.env=env;rmSync(cwd,{recursive:true,force:true})}
});

test('full mode offers no startup dialogs and legacy setup/upgrade commands need no console answer',async()=>{
  const env={...process.env};const cwd=mkdtempSync(join(tmpdir(),'okf-full-commands-'));process.env.PI_MEMORY_OWNERSHIP='full';
  const h=createHarness(extension,cwd,{hasUI:false,mode:'rpc'});
  try {
    await h.emit('session_start');assert.equal(h.confirmations.length,0);
    await h.commands['memory-setup']('',h.ctx);assert.ok(existsSync(join(cwd,'knowledge/index.md')));assert.equal(h.confirmations.length,0);
    h.events.on('pi-session-maintenance:control:v1',r=>{r.result=Promise.resolve({admission:'Started autonomous upgrade immediately.'});});
    await h.command();assert.equal(h.confirmations.length,0);assert.equal(h.prompts.length,0);
    assert.ok(h.messages.some(m=>m.message.content?.includes('Started autonomous upgrade')));
    const injected=await h.emit('before_agent_start');assert.ok(injected.some(r=>r?.message?.content?.includes('Full agent memory ownership')));
  }finally{await h.emit('session_shutdown');process.env=env;rmSync(cwd,{recursive:true,force:true})}
});

test('full ownership provisions a missing bundle and Git without any UI, using explicitly authorized identity',async()=>{
  const f=fixture({missing:true});
  try {
    const status=await f.run('status');assert.equal(status.available,true);assert.equal(status.setupRequired,true);assert.equal(status.ownershipProtocol,1);
    assert.equal(existsSync(f.bundle),false);assert.equal(f.calls,0);
    await f.run('upgrade',{memoryGitIdentity:{name:'Provisioned Agent',email:'agent@example.invalid'}});
    assert.equal((await f.run('status')).upgraded,true);assert.equal(git(f.bundle,'status','--porcelain'),'');
    assert.equal(git(f.bundle,'config','--get','user.name').trim(),'Provisioned Agent');
  }finally{await f.close()}
});

test('full ownership treats missing author identity as an external prerequisite, never invents it',async()=>{
  const f=fixture({missing:true});
  try {
    await assert.rejects(f.run('upgrade'),e=>e.code==='memory-external'&&e.detail.external.code==='credentials');
    assert.equal(f.calls,0);assert.equal(spawnSync('git',['-C',f.bundle,'config','--get','user.name']).status,1);
  }finally{await f.close()}
});

test('full recovery investigates source evidence and repairs schema/governance/staleness, then verifies and commits',async()=>{
  const f=fixture();let spend=0;
  try {
    await f.run('upgrade');const {path}=seedInvalid(f);f.sequence=evidenceRepair(f);const calls=f.calls;
    const result=await f.run('review',{onUsage:u=>spend+=u.cost.total});
    assert.equal(result.complete,false);assert.equal(result.detail.recovered,true);assert.equal(f.calls,calls+3);assert.equal(spend,.03);
    assert.equal(validateBundle(binary,f.bundle).ok,true);assert.match(readFileSync(path,'utf8'),/Historical proposal, not an established fact/);
    assert.equal(git(f.bundle,'status','--porcelain'),'');
    const state=JSON.parse(readFileSync(result.detail.casePath,'utf8'));assert.equal(state.status,'complete');assert.ok(state.checkpoints.length);
    const backup=JSON.parse(readFileSync(state.checkpoints[0],'utf8'));assert.match(backup.files['decision.md'],/governance: invalid/);
    assert.equal((await f.run('review')).complete,true);
    assert.ok(f.events.some(e=>e.type==='recovery-result'));assert.ok(f.prompts.some(p=>p.tools?.some(t=>t.name==='bash')));
  }finally{await f.close()}
});

test('limited ownership remains limited and never launches a broad recovery worker',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');seedInvalid(f);const calls=f.calls;
    await assert.rejects(f.run('review',{memoryOwnership:'limited'}),e=>e.code==='memory-validation');
    assert.equal(f.calls,calls);assert.ok(f.prompts.every(p=>!p.tools));
  }finally{await f.close()}
});

test('recovery budget yields durable progress and resumes automatically without repeating a completed tool',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');seedInvalid(f);f.sequence=evidenceRepair(f);
    await assert.rejects(f.run('review',{maxCost:.015}),e=>e.kind==='deferred'&&e.code==='memory-recovery-pending');
    const tools=f.events.filter(e=>e.type==='recovery-tool').length;const calls=f.calls;
    const result=await f.run('review');assert.equal(result.detail.recovered,true);assert.equal(f.calls,calls+1);
    assert.equal(f.events.filter(e=>e.type==='recovery-tool').length,tools);assert.equal(git(f.bundle,'status','--porcelain'),'');
  }finally{await f.close()}
});

test('false model completion cannot complete invalid memory or wait for a human; recovery continues automatically',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');seedInvalid(f);f.sequence=Array.from({length:8},()=>stop('Done; ask a human for repair approval.'));
    await assert.rejects(f.run('review'),e=>e.kind==='deferred'&&e.code==='memory-recovery-pending');
    assert.equal(validateBundle(binary,f.bundle).ok,false);
    f.sequence=evidenceRepair(f);assert.equal((await f.run('review')).detail.recovered,true);
  }finally{await f.close()}
});

test('full recovery enforces file-tool scope and protects upgrade receipts while letting the agent correct its own mistake',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');seedInvalid(f);const outside=join(f.cwd,'untouched.txt');writeFileSync(outside,'keep');
    const ledger=readFileSync(join(f.bundle,'.pi-okf-memory/state.json'),'utf8');
    f.sequence=[tool('write',{path:'../untouched.txt',content:'wrong'}),tool('write',{path:'.pi-okf-memory/state.json',content:'{}'}),...evidenceRepair(f)];
    const result=await f.run('review');assert.equal(result.detail.recovered,true);
    assert.equal(readFileSync(outside,'utf8'),'keep');assert.equal(readFileSync(join(f.bundle,'.pi-okf-memory/state.json'),'utf8'),ledger);
    const state=JSON.parse(readFileSync(result.detail.casePath,'utf8'));assert.equal(state.messages.filter(m=>m.role==='toolResult'&&m.isError).length,2);
  }finally{await f.close()}
});

test('an unsupported model claim of an external blocker cannot park repair awaiting a host',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');seedInvalid(f);
    f.sequence=Array.from({length:8},()=>stop(JSON.stringify({external:{code:'permission',reason:'Claimed read-only mount without operational evidence.'}})));
    await assert.rejects(f.run('review'),e=>e.code==='memory-recovery-pending');
    f.sequence=evidenceRepair(f);assert.equal((await f.run('review')).detail.recovered,true);
  }finally{await f.close()}
});

test('missing provider access is a verified external prerequisite, not a login dialog',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');seedInvalid(f);const calls=f.calls;f.ctx.modelRegistry.hasConfiguredAuth=()=>false;
    await assert.rejects(f.run('review'),e=>e.code==='memory-external'&&e.detail.external.code==='credentials'&&!!e.detail.recovery.casePath);
    assert.equal(f.calls,calls);
  }finally{await f.close()}
});

test('a corrupt ledger is archived and genuinely re-reviewed; incompatible ledgers never get reset',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');const file=join(f.bundle,'.pi-okf-memory/state.json');writeFileSync(file,'broken JSON');const calls=f.calls;
    assert.equal((await f.run('status')).upgraded,false);await f.run('upgrade');assert.equal(f.calls,calls+1);
    assert.equal((await f.run('status')).upgraded,true);
    assert.ok(readdirSync(join(f.cwd,'work/recovery',hash(f.bundle))).some(n=>n.startsWith('corrupt-ledger-')));
    writeFileSync(file,JSON.stringify({schema:99,completed:[]}));const bytes=readFileSync(file,'utf8');
    await assert.rejects(f.run('upgrade'),e=>e.code==='memory-external');assert.equal(readFileSync(file,'utf8'),bytes);
  }finally{await f.close()}
});

test('malformed extraction falls back to a tool-based review bound to the current source',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');f.sequence=[stop('invalid extraction JSON')];
    await assert.rejects(f.run('review'),e=>e.code==='memory-recovery-pending');
    f.sequence=[tool('read',{path:'../source.jsonl'}),input=>{
      const packet=JSON.parse(input.messages.find(m=>m.role==='user').content);
      return stop(JSON.stringify({reviewed:true,reviewedSourceHash:packet.source.hash}));
    }];
    const result=await f.run('review');assert.equal(result.complete,true);assert.equal(result.detail.evidence.reviewedSourceHash,JSON.parse(readFileSync(join(f.cwd,'source.jsonl'),'utf8')).hash);
    assert.equal(git(f.bundle,'status','--porcelain'),'');
  }finally{await f.close()}
});

test('full ownership can finish an oversized-corpus review incrementally without deleting valid memory',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');cli('create','large',f.bundle,'--title','Large historical evidence','--desc','Preserve historical evidence.','--body','A retained historical line.\n'.repeat(8000));
    const original=readFileSync(join(f.bundle,'large.md'),'utf8');
    f.sequence=[tool('read',{path:'../source.jsonl'}),input=>{
      const packet=JSON.parse(input.messages.find(m=>m.role==='user').content);
      return stop(JSON.stringify({reviewed:true,reviewedSourceHash:packet.source.hash}));
    }];
    const result=await f.run('review');assert.equal(result.complete,true);assert.equal(result.detail.recovered,true);
    assert.equal(readFileSync(join(f.bundle,'large.md'),'utf8'),original);assert.equal(git(f.bundle,'status','--porcelain'),'');
  }finally{await f.close()}
});

test('a failed upgrade proposal can be completed through tool-delivered guides with real ledger verification',async()=>{
  const f=fixture();
  try {
    f.sequence=[stop('invalid upgrade JSON')];await assert.rejects(f.run('upgrade'),e=>e.code==='memory-recovery-pending');
    f.sequence=[input=>{
      const packet=JSON.parse(input.messages.find(m=>m.role==='user').content);
      return {stopReason:'toolUse',content:packet.upgrade.paths.map((path,i)=>({type:'toolCall',id:'guide-'+i,name:'read',arguments:{path}}))};
    },input=>{
      const packet=JSON.parse(input.messages.find(m=>m.role==='user').content);
      return stop(JSON.stringify({reviewedUpgrade:{id:packet.upgrade.id,guideHash:packet.upgrade.guideHash}}));
    }];
    const result=await f.run('upgrade');assert.equal(result.complete,true);assert.equal((await f.run('status')).upgraded,true);
    assert.equal(git(f.bundle,'status','--porcelain'),'');assert.equal(JSON.parse(readFileSync(join(f.bundle,'.pi-okf-memory/state.json'),'utf8')).completed.length,1);
  }finally{await f.close()}
});

test('model capture opt-out retains operational recovery/checkpoints but no durable provider context',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');seedInvalid(f);f.sequence=evidenceRepair(f);
    const result=await f.run('review',{modelTranscripts:false});const state=JSON.parse(readFileSync(result.detail.casePath,'utf8'));
    assert.deepEqual(state.messages,[]);assert.equal(state.status,'complete');assert.ok(state.checkpoints.length);
  }finally{await f.close()}
});

test('recovery cancellation stops the real shell operation before releasing the bundle lease',async()=>{
  const f=fixture();const parent=new AbortController();
  try {
    await f.run('upgrade');seedInvalid(f);f.sequence=[tool('bash',{command:'sleep 10',timeout:30})];
    let started;const toolStarted=new Promise(resolve=>{started=resolve});
    const running=f.run('review',{signal:parent.signal,onEvent(type){if(type==='recovery-tool')started();}});
    await toolStarted;await assert.rejects(f.run('status'),e=>e.code==='memory-busy');
    const stopped=assert.rejects(running,/Foreground activity/);parent.abort(new Error('Foreground activity'));await stopped;
    assert.equal(existsSync(join(f.bundle,'.pi-okf-memory/lock.json')),false);assert.equal((await f.run('status')).available,true);
  }finally{await f.close()}
});

test('full ownership restores agent-owned access without changing content or Git object modes',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');const index=join(f.bundle,'index.md');const original=readFileSync(index,'utf8');const calls=f.calls;
    const object=git(f.bundle,'rev-parse','HEAD').trim();const objectPath=join(f.bundle,'.git/objects',object.slice(0,2),object.slice(2));
    const gitMode=statSync(objectPath).mode&0o777;
    chmodSync(index,0o400);chmodSync(f.bundle,0o500);
    await f.run('upgrade');assert.equal(f.calls,calls);assert.equal(readFileSync(index,'utf8'),original);
    assert.equal(statSync(index).mode&0o600,0o600);assert.equal(statSync(f.bundle).mode&0o700,0o700);
    assert.equal(statSync(objectPath).mode&0o777,gitMode);assert.ok(f.events.some(e=>e.detail?.action?.includes('owner-only access')));
  }finally{await f.close()}
});

test('private recovery storage cannot recurse into the knowledge bundle or be committed with it',async()=>{
  const f=fixture();
  try {
    await assert.rejects(f.run('upgrade',{workDir:join(f.bundle,'private-work')}),e=>e.code==='memory-external');
    assert.equal(f.calls,0);assert.equal(existsSync(join(f.bundle,'private-work')),false);
  }finally{await f.close()}
});

test('recoverable divergence in a dedicated memory repository merges the configured upstream and pushes normally',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');const remote=join(f.cwd,'remote.git');git(f.cwd,'init','--bare','--quiet',remote);
    git(f.bundle,'remote','add','origin',remote);const branch=git(f.bundle,'symbolic-ref','--short','HEAD').trim();
    git(f.bundle,'config',`branch.${branch}.remote`,'origin');git(f.bundle,'config',`branch.${branch}.merge`,`refs/heads/${branch}`);
    await f.run('push');const other=join(f.cwd,'other');git(f.cwd,'clone','--quiet',remote,other);
    git(other,'config','user.name','Other Agent');git(other,'config','user.email','other@example.invalid');git(other,'config','commit.gpgsign','false');
    writeFileSync(join(other,'remote-note.txt'),'Remote rationale.\n');git(other,'add','remote-note.txt');git(other,'commit','--quiet','--message','Remote knowledge');git(other,'push','--quiet');
    writeFileSync(join(f.bundle,'local-note.txt'),'Local rationale.\n');git(f.bundle,'add','local-note.txt');git(f.bundle,'commit','--quiet','--message','Local knowledge');
    f.sequence=[tool('bash',{command:`git fetch origin && git merge --no-edit ${JSON.stringify('origin/'+branch)}`}),stop('Fetched and merged the existing upstream, preserving both rationales.')];
    const result=await f.run('push');assert.equal(result.complete,true);
    assert.equal(git(remote,'rev-parse',`refs/heads/${branch}`),git(f.bundle,'rev-parse','HEAD'));
    assert.equal(readFileSync(join(f.bundle,'local-note.txt'),'utf8'),'Local rationale.\n');assert.equal(readFileSync(join(f.bundle,'remote-note.txt'),'utf8'),'Remote rationale.\n');
  }finally{await f.close()}
});

test('missing root navigation and an existing non-Git corpus repair under full ownership',async()=>{
  const f=fixture();
  try {
    cli('create','one',f.bundle,'--title','Rationale','--desc','Durable rationale.','--body','Keep all original evidence.');
    rmSync(join(f.bundle,'index.md'));rmSync(join(f.bundle,'.git'),{recursive:true});
    const result=await f.run('upgrade',{memoryGitIdentity:{name:'Explicit Agent',email:'agent@example.invalid'}});
    assert.equal(result.complete,false);assert.equal(validateBundle(binary,f.bundle).ok,true);
    assert.match(readFileSync(join(f.bundle,'one.md'),'utf8'),/Keep all original evidence/);
    await f.run('upgrade');assert.equal((await f.run('status')).upgraded,true);
  }finally{await f.close()}
});
