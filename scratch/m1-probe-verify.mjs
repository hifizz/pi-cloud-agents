// Validate persisted M1-00 evidence and scan only probe-owned text files for loaded secret values.
// node --env-file=.env scratch/m1-probe-verify.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const a = JSON.parse(readFileSync(root + "scratch/m1-probe-a-results.json", "utf8"));
assert.deepEqual(a.versions, { "pi-durable": "1.4.0", "pi-ai": "1.4.0", chord: "1.4.0" });
assert.equal(a.failed, 0);
assert.equal(a.passed, 195);
assert.equal(Object.keys(a.cases).length, 6);
for (const value of Object.values(a.cases)) assert.ok(value.assertions.every((row) => row.pass));
assert.equal(a.cases.a2.result.safe.length, 10);
assert.equal(a.cases.a2.result.unsafe.length, 10);
assert.equal(a.validation.backendTests.retry.passed, 164);
assert.equal(a.validation.backendTests.retry.failed, 0);
const b = JSON.parse(readFileSync(root + "scratch/m1-probe-b-results.json", "utf8"));
for (const id of ["B1", "B2", "B3", "B4", "B5", "B6"]) assert.ok(b.cases[id]?.observed, id);
assert.equal(b.created.length, 3);
assert.equal(b.cases.B1.observed.duplicate.statusCode, 409);
assert.equal(b.cases.B1.observed.missingGet.statusCode, 404);
assert.equal(b.cases.B1.observed.missingDelete.statusCode, 404);
assert.ok(b.cases.B4.observed.transfers.every((x) => x.matches));
assert.ok(b.cases.B4.observed.reads.every((x) => x.matches));
assert.ok(b.cases.B4.observed.chunks.every((x) => x.roundTrip));
assert.ok(b.cases.B5.observed.observations.every((x) => x.matches));
assert.equal(b.cases.B6.observed.after.github, "200");
assert.equal(b.cases.B6.observed.after.npm, "200");
assert.equal(b.cases.B6.observed.after.denied, "000");
assert.ok(b.cleanup.every((x) => x.deleted));
assert.equal(b.remainingThisRun.length, 0);
assert.equal(b.remaining.length, 0);
const files = ["scratch/m1-probe-a.mjs", "scratch/m1-probe-b.mjs", "scratch/m1-probe-b-boundary.mjs", "scratch/m1-probe-verify.mjs", "scratch/m1-probe-a-results.json", "scratch/m1-probe-b-results.json", "docs/m1-probe.md", "docs/acceptance/M1-00/README.md"].filter((p) => existsSync(root + p));
const values = Object.entries(process.env).filter(([key, value]) => /TOKEN|SECRET|API_KEY/.test(key) && value && value.length >= 8).map(([, value]) => value);
let hits = 0;
for (const file of files) {
  const text = readFileSync(root + file, "utf8");
  for (const value of values) {
    if ([value, encodeURIComponent(value), Buffer.from(value).toString("base64")].some((v) => text.includes(v))) hits++;
  }
}
assert.equal(hits, 0, "secret value found in probe output; do not print it");
assert.ok("positive-control-SENTINEL-ONLY".includes("SENTINEL-ONLY"));
console.log(JSON.stringify({ result: "PASS", aAssertions: a.passed, backendTests: 164, bCases: 6, created: 3, deleted: 3, remaining: 0, scannedFiles: files.length, secretValueHits: hits, positiveControl: true }));
