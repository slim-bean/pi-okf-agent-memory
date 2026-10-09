import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { jiti } from './loader.mjs';
import { createHarness } from './support.mjs';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { default: extension, resolveOkfBin } = await jiti.import(join(root, 'index.ts'));
const binary = resolveOkfBin();
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const cli = (...args) => execFileSync(binary, args, { encoding:'utf8' });
const git = (dir,...args) => execFileSync('git',['-C',dir,...args],{encoding:'utf8'});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'okf-maintenance-'));
  const bundle = join(cwd,'knowledge'); cli('init',bundle);
  git(bundle,'init','--quiet'); git(bundle,'config','user.name','Offline Tests');
  git(bundle,'config','user.email','offline@example.invalid'); git(bundle,'config','commit.gpgsign','false');
  const h=createHarness(extension,cwd);
  let response={reviewed:true, changes:[]}; let calls=0;
  const model={provider:'fake',id:'offline',contextWindow:200000,maxTokens:8192};
  h.ctx.model=model;
  h.ctx.modelRegistry={find:()=>model,hasConfiguredAuth:()=>true,streamSimple(_model,input) {
    calls++; assert.match(input.systemPrompt,/UNTRUSTED/);
    const result={role:'assistant',api:'openai-responses',provider:'fake',model:'offline',timestamp:Date.now(),stopReason:'stop',content:[{type:'text',text:JSON.stringify(response)}],usage:{cost:{total:0.01}}};
    return {async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:result.content[0].text};},result:async()=>result};
  }};
  const entries=[{index:1,id:'a',parentId:null,timestampMs:1,role:'user',text:'Persist the rationale for isolated test profiles.'}];
  const source={path:join(cwd,'source.jsonl'),cwd,hash:hash(entries),entries};
  const run=async(operation, extras={})=>{
    const r={protocol:1,operation,context:h.ctx,cwd,source,workDir:join(cwd,'work'),assertSource(){},...extras};
    h.events.emit('okf:maintenance:v1',r); assert.ok(r.result); return r.result;
  };
  return {cwd,bundle,h,run,get calls(){return calls},set response(value){response=value},close(){rmSync(cwd,{recursive:true,force:true})}};
}

test('capability is read-only; unattended upgrades and no-change review commit without prompting',async()=>{
  const f=fixture();
  try {
    const caps={}; f.h.events.emit('pi-session-maintenance:capabilities:v1',caps);
    assert.equal(caps.capabilities.memory.protocol,1);
    const status=await f.run('status'); assert.equal(status.upgraded,false); assert.equal(f.calls,0);
    await f.run('upgrade'); assert.equal((await f.run('status')).upgraded,true);
    const reviewed=await f.run('review'); assert.equal(reviewed.complete,true);
    const paid=f.calls; await f.run('review'); assert.equal(f.calls,paid);
    assert.equal(git(f.bundle,'status','--porcelain'),''); assert.equal(f.h.prompts.length,0);
    await assert.rejects(f.run('push'),e=>e.kind==='blocked'&&e.code==='git-upstream'&&/upstream/.test(e.message));
  } finally {f.close()}
});

test('optional model and operation observers capture exact prompts, parsed deltas, usage and commit references',async()=>{
  const f=fixture();const events=[];const operations=[];let cost=0;
  try {
    await f.run('upgrade',{onModelEvent:event=>events.push(event),onEvent:(type,detail)=>operations.push({type,detail}),onUsage:usage=>cost+=usage.cost.total});
    assert.deepEqual(events.map(event=>event.type),['start','delta','end']);
    assert.match(events[0].systemPrompt,/UNTRUSTED/);assert.equal(events[2].message.role,'assistant');
    assert.equal(events[0].timeoutMs,600000);assert.ok(events[2].elapsedMs>=0);
    assert.equal(cost,.01);assert.ok(operations.some(event=>event.type==='commit'&&event.detail.commit));
    events.length=0;
    await assert.rejects(f.run('review',{onModelEvent:event=>{if(event.type==='delta')throw new Error('transcript unavailable');}}),/transcript unavailable/);
    assert.equal(git(f.bundle,'status','--porcelain'),'');
  }finally{f.close()}
});

test('timeout and foreground cancellation record their actual causes without knowledge writes',async()=>{
  const f=fixture();const keepAlive=setTimeout(()=>{},1000);
  try {
    await f.run('upgrade');
    f.h.ctx.modelRegistry.streamSimple=(_m,_i,options)=>({result:()=>new Promise(resolve=>{
      const finish=()=>resolve({role:'assistant',provider:'fake',model:'offline',api:'openai-responses',timestamp:Date.now(),
        stopReason:'aborted',content:[],usage:{cost:{total:.01}}});
      if(options.signal.aborted)finish();else options.signal.addEventListener('abort',finish,{once:true});
    })});
    const events=[];let cost=0;
    await assert.rejects(f.run('review',{modelTimeoutMs:20,onModelEvent:e=>events.push(e),onUsage:u=>cost+=u.cost.total}),/timed out after 0.02s/);
    assert.match(events.at(-1).abortReason,/timed out/);assert.equal(events.at(-1).timeoutMs,20);assert.equal(cost,.01);
    const parent=new AbortController();
    const request=f.run('review',{signal:parent.signal,onModelEvent:e=>{if(e.type==='start')parent.abort(new Error('Peer foreground input'));}});
    await assert.rejects(request,/Peer foreground input/);
    assert.equal(git(f.bundle,'status','--porcelain'),'');
  }finally{clearTimeout(keepAlive);f.close()}
});

test('warranted changes use CLI and commit automatically; stale source prevents writes',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');
    f.response={reviewed:true,changes:[{concept:'decisions/isolation',title:'Isolated tests',description:'Protect personal state during automated tests.',body:'Dedicated temporary profiles prevent accidental changes to authenticated user state.',type:'Decision',entries:[1]}]};
    await assert.rejects(f.run('review',{assertSource(){throw new Error('source changed')}}),/source changed/);
    await f.run('review');
    assert.match(readFileSync(join(f.bundle,'decisions/isolation.md'),'utf8'),/Source:.*source.jsonl/);
    assert.equal(git(f.bundle,'status','--porcelain'),'');
    assert.match(git(f.bundle,'log','-1','--format=%s'),/maintain knowledge/);
  } finally {f.close()}
});

test('failed commit retries its checkpoint without another model call, and configured push uses existing upstream',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');
    f.response={reviewed:true,changes:[{concept:'decisions/retries',title:'Retry finalization',description:'Do not pay for another extraction after Git failure.',body:'Persist the proposed change before applying it so Git finalization can be retried independently.',type:'Decision',entries:[1]}]};
    const hooks=join(f.bundle,'.git','hooks');mkdirSync(hooks,{recursive:true});
    const hook=join(hooks,'pre-commit');writeFileSync(hook,'#!/bin/sh\nexit 1\n');chmodSync(hook,0o700);
    await assert.rejects(f.run('review'),/git commit failed/);
    const calls=f.calls;unlinkSync(hook);
    await f.run('review');assert.equal(f.calls,calls);
    const remote=join(f.cwd,'remote.git');git(f.cwd,'init','--bare','--quiet',remote);
    git(f.bundle,'remote','add','origin',remote);
    const branch=git(f.bundle,'symbolic-ref','--short','HEAD').trim();
    git(f.bundle,'config',`branch.${branch}.remote`,'origin');
    git(f.bundle,'config',`branch.${branch}.merge`,`refs/heads/${branch}`);
    await f.run('push');assert.equal(f.calls,calls);
    assert.equal(git(remote,'rev-parse',`refs/heads/${branch}`),git(f.bundle,'rev-parse','HEAD'));
  } finally {f.close()}
});

test('orphan-only blocked plans resume validation and commit without another extraction call',async()=>{
  const f=fixture();const previous=process.env.OKF_ORPHAN_POLICY;
  try {
    delete process.env.OKF_ORPHAN_POLICY;
    await f.run('upgrade');
    for(const id of ['independent-one','independent-two']) cli('create',id,f.bundle,'--title',id,'--desc','An independent topic.','--body','Unrelated durable rationale.');
    process.env.OKF_ORPHAN_POLICY='strict';
    const strictKey=(await f.run('status')).key;
    await assert.rejects(f.run('review'),e=>e.kind==='blocked'&&e.code==='memory-validation'&&e.resource===realpathSync(f.bundle));
    const calls=f.calls;
    process.env.OKF_ORPHAN_POLICY='advisory';
    assert.notEqual((await f.run('status')).key,strictKey);
    const result=await f.run('review');
    assert.equal(result.complete,true);assert.equal(f.calls,calls);
    assert.equal(result.detail.advisories[0].code,'isolated-concepts');
    assert.equal(git(f.bundle,'status','--porcelain'),'');
    assert.doesNotMatch(readFileSync(join(f.bundle,'independent-one.md'),'utf8'),/independent-two/);
  } finally {if(previous===undefined)delete process.env.OKF_ORPHAN_POLICY;else process.env.OKF_ORPHAN_POLICY=previous;f.close()}
});

test('Git diagnostics provide stable codes for specific next-step guidance',async()=>{
  const {gitIssue}=await jiti.import(join(root,'lib/maintenance-issue.ts'));
  for(const [text,code] of [
    ['Author identity unknown','git-identity'],['Unmerged Git index; maintenance deferred','git-conflict'],
    ['Permission denied (publickey)','git-auth'],['gpg failed to sign the data','git-signing'],
    ['[rejected] main -> main (non-fast-forward)','git-push-rejected'],
  ]) {
    const issue=gitIssue('/knowledge',new Error(text),'push');
    assert.equal(issue.code,code);assert.equal(issue.kind,'blocked');assert.equal(issue.resource,'/knowledge');
  }
  assert.equal(gitIssue('/knowledge',new Error('network unreachable'),'push').code,'git-push');
});

test('malformed proposals and outside-entry references cannot mutate the bundle',async()=>{
  const f=fixture();
  try {
    await f.run('upgrade');
    const before=git(f.bundle,'rev-parse','HEAD');
    f.response={reviewed:true,changes:[{concept:'../escape',title:'x',description:'x',body:'x',entries:[1]}]};
    await assert.rejects(f.run('review'),/concept ID/);
    f.response={reviewed:true,changes:[{concept:'decisions/no',title:'x',description:'x',body:'x',entries:[999]}]};
    await assert.rejects(f.run('review'),/cite entries/);
    assert.equal(git(f.bundle,'rev-parse','HEAD'),before);
  } finally {f.close()}
});
