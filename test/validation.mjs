import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const {resolveOkfBin}=await jiti.import(join(root,'index.ts'));
const {validateBundle,orphanPolicy}=await jiti.import(join(root,'lib/okf.ts'));
const binary=resolveOkfBin();
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'okf-orphan-policy-'));const bundle=join(dir,'knowledge');
 const cli=(...args)=>execFileSync(binary,args,{encoding:'utf8'});
 cli('init',bundle);
 for(const id of ['one','two'])cli('create',id,bundle,'--type','Fact','--title',id,'--desc',`Independent ${id} rationale`,'--body','A durable independent observation.');
 return {dir,bundle,cli,close(){rmSync(dir,{recursive:true,force:true})}};
}
test('indexed isolated concepts are advisory by default, with explicit strict inspection',()=>{
 const f=fixture();
 try {
  const result=validateBundle(binary,f.bundle,'advisory');
  assert.equal(result.ok,true);assert.equal(result.strictValidation.gate_passed,false);
  assert.equal(result.validation.gate_passed,true);assert.equal(result.validation.orphans.length,2);
  assert.equal(result.advisories[0].code,'isolated-concepts');
  assert.equal(validateBundle(binary,f.bundle,'strict').ok,false);
  assert.throws(()=>orphanPolicy('ignore-everything'),/advisory or strict/);
 }finally{f.close()}
});
test('orphan advice cannot mask index drift, broken links, invalid governance or stale facts',()=>{
 const f=fixture();
 try {
  const index=join(f.bundle,'index.md'),originalIndex=readFileSync(index,'utf8');
  writeFileSync(index,originalIndex.split('\n').filter(line=>!line.includes('(one.md)')).join('\n'));
  assert.equal(validateBundle(binary,f.bundle,'advisory').ok,false);
  writeFileSync(index,originalIndex);
  const file=join(f.bundle,'one.md'),original=readFileSync(file,'utf8');
  f.cli('update','one',f.bundle,'--body','A [broken relationship](missing.md).');
  assert.equal(validateBundle(binary,f.bundle,'advisory').ok,false);
  writeFileSync(file,original);
  writeFileSync(file,original.replace('---\n','---\ngovernance: invalid\n'));
  assert.equal(validateBundle(binary,f.bundle,'advisory').ok,false);
  writeFileSync(file,original.replace('---\n','---\nstale_after: 2000-01-01\n'));
  const stale=validateBundle(binary,f.bundle,'advisory');assert.equal(stale.ok,false);
 }finally{f.close()}
});
