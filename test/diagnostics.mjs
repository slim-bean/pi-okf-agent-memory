import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti } from './loader.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const {binaryDiagnostics,formatBinaryDiagnostics,requireOkfBin}=await jiti.import(join(root,'lib/diagnostics.ts'));
const {resolveOkfBin}=await jiti.import(join(root,'lib/okf.ts'));

test('missing/unusable binary diagnostics identify loaded package, host, lookup candidates and declarations without credentials',()=>{
  const work=mkdtempSync(join(tmpdir(),'okf-diagnostics-'));
  const env=Object.fromEntries(['OKF_BIN','PATH','PI_CODING_AGENT_DIR'].map(k=>[k,process.env[k]]));
  const pkg=join(work,'pkg'),cwd=join(work,'project'),agent=join(work,'agent'),entry=join(pkg,'index.ts');
  try{
    mkdirSync(pkg);mkdirSync(join(cwd,'.pi'),{recursive:true});mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR=agent;process.env.PATH=join(work,'empty-path');delete process.env.OKF_BIN;
    writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[pkg],secret:'DO_NOT_PRINT'}));
    writeFileSync(join(cwd,'.pi/settings.json'),JSON.stringify({packages:['../../pkg'],unrelated:'DO_NOT_PRINT'}));
    const d=binaryDiagnostics(entry,cwd);
    assert.equal(d.selected,null);assert.equal(d.extensionFile,entry);assert.equal(d.packageDir,pkg);assert.equal(d.cwd,cwd);
    assert.ok(d.candidates.some(c=>c.path===join(pkg,'bin',`okf-${process.platform}-${process.arch==='x64'?'amd64':process.arch}`)));
    assert.equal(d.settings[0].matches[0],`packages: ${pkg}`);assert.equal(d.settings[1].matches[0],`packages: ${pkg}`);
    assert.doesNotMatch(JSON.stringify(d),/DO_NOT_PRINT/);
    assert.throws(()=>requireOkfBin(entry,cwd),error=>error.code==='okf-binary'&&error.kind==='blocked'&&error.resource===pkg&&error.message.includes(join(cwd,'.pi/settings.json'))&&error.message.includes(entry));
    process.env.OKF_BIN='missing-override';
    const override=binaryDiagnostics(entry,cwd);assert.equal(override.candidates.length,1);assert.equal(override.selected,join(cwd,'missing-override'));
    assert.match(formatBinaryDiagnostics(override),/fallbacks disabled/);
    const executable=join(cwd,'custom-okf');writeFileSync(executable,'not executed by diagnostics');chmodSync(executable,0o700);
    process.env.OKF_BIN='custom-okf';assert.equal(requireOkfBin(entry,cwd),executable);assert.equal(resolveOkfBin(pkg,cwd),executable);
    chmodSync(executable,0o600);assert.throws(()=>requireOkfBin(entry,cwd),/not executable/);
    process.env.OKF_BIN='.';assert.throws(()=>requireOkfBin(entry,cwd),/not a regular file/);
  }finally{
    for(const[k,v]of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    rmSync(work,{recursive:true,force:true});
  }
});
