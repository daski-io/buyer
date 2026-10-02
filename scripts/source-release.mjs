// CI only; enabled by the explicit coordinator handoff variable.
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
// Include package contents and every shared input used by the pinned tsc/npm
// build. Comparing package trees is deliberately conservative: a same-version
// source release is a no-op only when its publishable inputs are unchanged.
export const PACKAGE_INPUTS=[
 "packages/pay","packages/x402-scheme","package.json","package-lock.json",
 ".npmrc",".npmignore",":(glob)tsconfig*.json",":(glob)LICENSE*",":(glob)README*",
];
export function sourceRelease({exec=execFileSync,read=readFileSync,env=process.env}={}) {
const commit=env.SOURCE_SHA,repo=env.GITHUB_REPOSITORY;
if(!/^[a-f0-9]{40}$/.test(commit??"") || repo!=="daski-io/buyer") throw new Error("Exact trusted source release identity required");
if(exec("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()!==commit) throw new Error("Source checkout changed");
const pay=JSON.parse(read("packages/pay/package.json","utf8"));
const scheme=JSON.parse(read("packages/x402-scheme/package.json","utf8"));
if(pay.version!==scheme.version || pay.dependencies["@daski/x402-scheme"]!==scheme.version || !/^\d+\.\d+\.\d+$/.test(pay.version))
 throw new Error("Both package versions and the exact scheme pin must match");
const tag="v"+pay.version;
const refs=exec("git",["ls-remote","--tags","origin","refs/tags/"+tag,"refs/tags/"+tag+"^{}"],{encoding:"utf8"});
if(refs.trim()) {
 const entries=refs.trim().split("\n").map(x=>x.split(/\s+/)), actual=entries.find(x=>x[1].endsWith("^{}"))?.[0]??entries[0][0];
 if(actual!==commit) {
  // Tooling-only commits retain the already allocated version. Verify the
  // immutable tag is an ancestor and names this same package version before
  // treating this as a no-op; never republish different bytes under that tag.
  exec("git",["fetch","origin","tag",tag],{stdio:["ignore","pipe","pipe"]});
  exec("git",["merge-base","--is-ancestor",actual,commit],{stdio:["ignore","pipe","pipe"]});
  for(const path of ["packages/pay/package.json","packages/x402-scheme/package.json"]) {
   const manifest=JSON.parse(exec("git",["show",actual+":"+path],{encoding:"utf8"}));
   if(manifest.version!==pay.version)throw new Error("Existing version tag does not describe these package versions");
  }
  try {
   exec("git",["diff","--quiet",actual,commit,"--",...PACKAGE_INPUTS],{stdio:["ignore","pipe","pipe"]});
  } catch {
   throw new Error("Package contents or build inputs changed since "+tag+"; bump both package versions and the exact scheme pin before source publication");
  }
  return {status:"UNCHANGED_VERSION",tag,commit:actual};
 }
} else exec("gh",["api","--method","POST","repos/"+repo+"/git/refs","--input","-"],{
 input:JSON.stringify({ref:"refs/tags/"+tag,sha:commit}),stdio:["pipe","pipe","pipe"]});
// GITHUB_TOKEN-created tags do not trigger another workflow, so dispatch the
// existing trusted publisher at this tag, never at a mutable develop head.
for(const name of ["@daski/x402-scheme","@daski/pay"])
 exec("gh",["workflow","run","release.yml","--repo",repo,"--ref",tag,
  "-f","package="+name,"-f","dist_tag=next","-f","release_attempt=source-"+commit],{stdio:["ignore","pipe","pipe"]});

return {status:"DISPATCHED",tag,commit};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.stdout.write(JSON.stringify(sourceRelease())+"\n");
