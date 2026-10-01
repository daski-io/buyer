// CI only; enabled by the explicit coordinator handoff variable.
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
const commit=process.env.SOURCE_SHA,repo=process.env.GITHUB_REPOSITORY;
if(!/^[a-f0-9]{40}$/.test(commit??"") || repo!=="daski-io/buyer") throw new Error("Exact trusted source release identity required");
if(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()!==commit) throw new Error("Source checkout changed");
const pay=JSON.parse(readFileSync("packages/pay/package.json","utf8"));
const scheme=JSON.parse(readFileSync("packages/x402-scheme/package.json","utf8"));
if(pay.version!==scheme.version || pay.dependencies["@daski/x402-scheme"]!==scheme.version || !/^\d+\.\d+\.\d+$/.test(pay.version))
 throw new Error("Both package versions and the exact scheme pin must match");
const tag="v"+pay.version;
const refs=execFileSync("git",["ls-remote","--tags","origin","refs/tags/"+tag,"refs/tags/"+tag+"^{}"],{encoding:"utf8"});
if(refs.trim()) {
 const entries=refs.trim().split("\n").map(x=>x.split(/\s+/)), actual=entries.find(x=>x[1].endsWith("^{}"))?.[0]??entries[0][0];
 if(actual!==commit) throw new Error("Version tag belongs to another source; bump versions in the change before publication");
} else execFileSync("gh",["api","--method","POST","repos/"+repo+"/git/refs","--input","-"],{
 input:JSON.stringify({ref:"refs/tags/"+tag,sha:commit}),stdio:["pipe","pipe","pipe"]});
// GITHUB_TOKEN-created tags do not trigger another workflow, so dispatch the
// existing trusted publisher at this tag, never at a mutable develop head.
for(const name of ["@daski/x402-scheme","@daski/pay"])
 execFileSync("gh",["workflow","run","release.yml","--repo",repo,"--ref",tag,
  "-f","package="+name,"-f","dist_tag=next","-f","release_attempt=source-"+commit],{stdio:["ignore","pipe","pipe"]});
