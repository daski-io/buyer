import test from "node:test";import assert from "node:assert/strict";
import {publicationRecord} from "./publication-record.mjs";
const args={name:"@daski/pay",manifest:{name:"@daski/pay",version:"1.2.3"},commit:"a".repeat(40),runId:1,runAttempt:1,
 registry:{name:"@daski/pay",version:"1.2.3",gitHead:"a".repeat(40),dist:{integrity:"sha512-YQ==",attestations:{url:"https://registry.npmjs.org/-/npm/v1/attestations/x"}}}};
test("publication records exact immutable package identity",()=>{assert.equal(publicationRecord(args).integrity,"sha512-YQ==");});
test("same version from another source and missing provenance cannot qualify",()=>{
 assert.throws(()=>publicationRecord({...args,registry:{...args.registry,gitHead:"b".repeat(40)}}),/does not match/);
 assert.throws(()=>publicationRecord({...args,registry:{...args.registry,dist:{integrity:"sha512-YQ=="}}}),/does not match/);
});
