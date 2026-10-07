import test from "node:test";import assert from "node:assert/strict";
import {publicationRecord,servedPublication} from "./publication-record.mjs";
const args={name:"@daski/pay",manifest:{name:"@daski/pay",version:"1.2.3"},commit:"a".repeat(40),runId:1,runAttempt:1,
 registry:{name:"@daski/pay",version:"1.2.3",gitHead:"a".repeat(40),dist:{integrity:"sha512-YQ==",attestations:{url:"https://registry.npmjs.org/-/npm/v1/attestations/x"}}}};
test("publication records exact immutable package identity",()=>{assert.equal(publicationRecord(args).integrity,"sha512-YQ==");});
test("same version from another source and missing provenance cannot qualify",()=>{
 assert.throws(()=>publicationRecord({...args,registry:{...args.registry,gitHead:"b".repeat(40)}}),/does not match/);
 assert.throws(()=>publicationRecord({...args,registry:{...args.registry,dist:{integrity:"sha512-YQ=="}}}),/does not match/);
});
test("a fresh publication is read until npm serves it with its provenance",async()=>{
 let clock=0,views=0;
 const served=await servedPublication({name:"@daski/pay",version:"1.2.3",now:()=>clock,deadline:60000,pause:async ms=>{clock+=ms;},
  view:()=>{views++;if(views===1)throw new Error("E404");return views===2?{...args.registry,dist:{integrity:"sha512-YQ=="}}:args.registry;}});
 assert.equal(views,3);assert.equal(clock,30000);assert.equal(publicationRecord({...args,registry:served}).integrity,"sha512-YQ==");
});
test("a version npm never serves fails at the deadline and records nothing",async()=>{
 let clock=0,views=0;
 await assert.rejects(servedPublication({name:"@daski/pay",version:"1.2.3",now:()=>clock,deadline:45000,pause:async ms=>{clock+=ms;},
  view:()=>{views++;throw new Error("E404");}}),/does not serve/);
 assert.equal(views,3);
});
