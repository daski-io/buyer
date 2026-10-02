import test from "node:test";
import assert from "node:assert/strict";
import {sourceRelease,PACKAGE_INPUTS} from "./source-release.mjs";
const current="a".repeat(40),prior="b".repeat(40);
function fixture({ancestor=true,existing=true,changedInputs=false}={}) {
 const calls=[];
 const exec=(tool,args)=>{calls.push([tool,...args]);
  if(args[0]==="rev-parse")return current;
  if(args[0]==="ls-remote")return existing?prior+"\trefs/tags/v0.5.1":"";
  if(args[0]==="merge-base"&&!ancestor)throw Error("diverged");
  if(args[0]==="diff"&&changedInputs)throw Error("differs");
  if(args[0]==="show")return JSON.stringify({version:"0.5.1"});
  return "";
 };
 return {calls,args:{exec,env:{SOURCE_SHA:current,GITHUB_REPOSITORY:"daski-io/buyer"},
  read:()=>JSON.stringify({version:"0.5.1",dependencies:{"@daski/x402-scheme":"0.5.1"}})}};
}
test("a later non-bumping commit skips publication and does not move the tag",()=>{
 const f=fixture();assert.equal(sourceRelease(f.args).status,"UNCHANGED_VERSION");
 assert.equal(f.calls.some(c=>c[0]==="gh"),false);
 assert.deepEqual(f.calls.find(c=>c[1]==="diff"),["git","diff","--quiet",prior,current,"--",...PACKAGE_INPUTS]);
});
test("a divergent existing version tag remains a refusal",()=>{
 const f=fixture({ancestor:false});assert.throws(()=>sourceRelease(f.args),/diverged/);
 assert.equal(f.calls.some(c=>c[0]==="gh"),false);
});
test("new source version allocates one immutable tag and dispatches both publishers",()=>{
 const f=fixture({existing:false});assert.equal(sourceRelease(f.args).status,"DISPATCHED");
 assert.equal(f.calls.filter(c=>c[0]==="gh"&&c[1]==="workflow").length,2);
});


test("same-version package changes refuse publication rather than silently skipping",()=>{
 const f=fixture({changedInputs:true});assert.throws(()=>sourceRelease(f.args),/bump both package versions/);
 assert.equal(f.calls.some(c=>c[0]==="gh"),false);
});

import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
test("real git comparison distinguishes tooling changes from package, build and lockfile changes",()=>{
 const root=mkdtempSync(join(tmpdir(),"buyer-unchanged-version-"));
 const git=(...args)=>execFileSync("git",args,{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 const put=(path,value)=>{mkdirSync(join(root,path,".."),{recursive:true});writeFileSync(join(root,path),value);};
 try {
  git("init","--quiet");git("config","user.name","Test");git("config","user.email","test@example.invalid");
  for(const packageName of ["pay","x402-scheme"]){
   put("packages/"+packageName+"/package.json",JSON.stringify({version:"0.5.1",dependencies:{"@daski/x402-scheme":"0.5.1"}}));
   put("packages/"+packageName+"/src/index.ts","export const value = 1;\n");
  }
  put("package-lock.json","{}\n");put("tsconfig.json","{}\n");put("scripts/release.mjs","// first\n");
  git("add",".");git("commit","--quiet","-m","Package version");const tagged=git("rev-parse","HEAD");
  const exec=(tool,args,options)=>{
   if(tool==="gh")throw Error("Unchanged version must not publish");
   if(args[0]==="ls-remote")return tagged+"\trefs/tags/v0.5.1";
   if(args[0]==="fetch")return "";
   return execFileSync(tool,args,{...options,cwd:root});
  };
  for(const path of ["scripts/release.mjs","packages/pay/src/index.ts","packages/x402-scheme/src/index.ts","package-lock.json","tsconfig.json"]){
   put(path,"// changed\n");git("add",path);git("commit","--quiet","-m","Change input");
   const args={exec,env:{SOURCE_SHA:git("rev-parse","HEAD"),GITHUB_REPOSITORY:"daski-io/buyer"},
     read:(path,encoding)=>readFileSync(join(root,path),encoding)};
   if(path==="scripts/release.mjs")assert.equal(sourceRelease(args).status,"UNCHANGED_VERSION");
   else assert.throws(()=>sourceRelease(args),/build inputs changed/);
   // Each case starts from the same immutable package version.
   git("reset","--hard",tagged);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
