import {readFileSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
export function publicationRecord({name,manifest,registry,commit,runId,runAttempt}) {
 if(!["@daski/pay","@daski/x402-scheme"].includes(name) || manifest.name!==name || registry.name!==name ||
    registry.version!==manifest.version || registry.gitHead!==commit ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(registry.dist?.integrity??"") ||
    !registry.dist?.attestations?.url?.startsWith("https://registry.npmjs.org/-/npm/v1/attestations/"))
   throw new Error("Published package identity, integrity or provenance does not match the source release");
 return {schemaVersion:1,kind:"npm",name,version:registry.version,commit,integrity:registry.dist.integrity,
  provenance:registry.dist.attestations.url,dependencies:registry.dependencies??{},ci:{runId,runAttempt}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const name=process.env.PACKAGE;
 if(!["@daski/pay","@daski/x402-scheme"].includes(name)) throw new Error("Unknown package");
 const manifest=JSON.parse(readFileSync("packages/"+name.split("/")[1]+"/package.json","utf8"));
 const registry=JSON.parse(execFileSync("npm",["view",name+"@"+manifest.version,"--json"],{encoding:"utf8",timeout:30000}));
 writeFileSync("package-publication.json",JSON.stringify(publicationRecord({name,manifest,registry,
  commit:process.env.GITHUB_SHA,runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT)}),null,2)+"\n");
}
