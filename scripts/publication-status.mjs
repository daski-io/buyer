import {readFileSync,appendFileSync} from "node:fs";
import {publicationRecord} from "./publication-record.mjs";
const name=process.env.PACKAGE;
if(!["@daski/pay","@daski/x402-scheme"].includes(name)) throw new Error("Unknown package");
const manifest=JSON.parse(readFileSync("packages/"+name.split("/")[1]+"/package.json","utf8"));
const response=await fetch("https://registry.npmjs.org/"+encodeURIComponent(name)+"/"+manifest.version,{signal:AbortSignal.timeout(30000)});
let publish;
if(response.status===404) publish=true;
else if(response.status===200) {
 publicationRecord({name,manifest,registry:await response.json(),commit:process.env.GITHUB_SHA,
  runId:Number(process.env.GITHUB_RUN_ID),runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT)});
 publish=false;
} else throw new Error("Registry publication observation unavailable; do not infer missing version");
if(!process.env.GITHUB_OUTPUT) throw new Error("This command runs only in publication CI");
appendFileSync(process.env.GITHUB_OUTPUT,"publish="+publish+"\n");
