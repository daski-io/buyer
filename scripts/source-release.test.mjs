import test from "node:test";
import assert from "node:assert/strict";
import {sourceRelease} from "./source-release.mjs";
const current="a".repeat(40),prior="b".repeat(40);
function fixture({ancestor=true,existing=true}={}) {
 const calls=[];
 const exec=(tool,args)=>{calls.push([tool,...args]);
  if(args[0]==="rev-parse")return current;
  if(args[0]==="ls-remote")return existing?prior+"\trefs/tags/v0.5.1":"";
  if(args[0]==="merge-base"&&!ancestor)throw Error("diverged");
  if(args[0]==="show")return JSON.stringify({version:"0.5.1"});
  return "";
 };
 return {calls,args:{exec,env:{SOURCE_SHA:current,GITHUB_REPOSITORY:"daski-io/buyer"},
  read:()=>JSON.stringify({version:"0.5.1",dependencies:{"@daski/x402-scheme":"0.5.1"}})}};
}
test("a later non-bumping commit skips publication and does not move the tag",()=>{
 const f=fixture();assert.equal(sourceRelease(f.args).status,"UNCHANGED_VERSION");
 assert.equal(f.calls.some(c=>c[0]==="gh"),false);
});
test("a divergent existing version tag remains a refusal",()=>{
 const f=fixture({ancestor:false});assert.throws(()=>sourceRelease(f.args),/diverged/);
 assert.equal(f.calls.some(c=>c[0]==="gh"),false);
});
test("new source version allocates one immutable tag and dispatches both publishers",()=>{
 const f=fixture({existing:false});assert.equal(sourceRelease(f.args).status,"DISPATCHED");
 assert.equal(f.calls.filter(c=>c[0]==="gh"&&c[1]==="workflow").length,2);
});
