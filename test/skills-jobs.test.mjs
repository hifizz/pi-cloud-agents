// Offline tests for skills (7) and background jobs (15) using NodeExecutionEnv (a real local env, no sandbox):
// save/list/read/delete skills; start_job -> job_wait lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openHarness, ctx } from "../src/harness.mjs";
import { BotRegistry } from "../src/bots.mjs";
import { Preamble } from "../src/ext/preamble.mjs";
import { createSkills, checkName, parseListing, listScript } from "../src/ext/skills.mjs";
import { createJobs } from "../src/ext/jobs.mjs";

const MODEL = { provider: "faux", modelId: "faux-1" };

function faux(responses) {
  const f = fauxProvider();
  const models = createModels();
  models.setProvider(f.provider);
  f.setResponses(responses);
  return { models, model: MODEL };
}

async function toolResultTexts(conv) {
  const page = await conv.entries({}, 50, undefined, ctx);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => (e.model[0].content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
}

test("checkName + parseListing pure helpers", () => {
  assert.equal(checkName("my-skill-1"), "my-skill-1");
  assert.throws(() => checkName("Bad Name"));
  assert.throws(() => checkName("../evil"));
  const listing = parseListing("deploy.md\nDeploy the app to Fly\n\nnotes.md\nTake notes\n");
  assert.deepEqual(listing.map((s) => s.name), ["deploy", "notes"]);
  assert.equal(listing[0].summary, "Deploy the app to Fly");
  assert.deepEqual(parseListing(""), []);
});

test("skills: save, list, read, delete through a real env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  const skillsDir = join(dir, ".skills");
  const env = new NodeExecutionEnv({ cwd: dir });
  const skills = createSkills({ skillsDir });
  const save = skills.tools.find((t) => t.name === "save_skill");
  const list = skills.tools.find((t) => t.name === "list_skills");
  const read = skills.tools.find((t) => t.name === "read_skill");
  const del = skills.tools.find((t) => t.name === "delete_skill");

  const api = { conversationId: 1, env };
  const out = await save.execute({ name: "deploy-fly", summary: "Deploy the app to Fly", body: "1. fly deploy\n2. verify" }, api, {});
  assert.match(out.output[0].text, /saved skill deploy-fly/);

  const l = await list.execute({}, api, {});
  assert.match(l.output[0].text, /deploy-fly: Deploy the app to Fly/);

  const r = await read.execute({ name: "deploy-fly" }, api, {});
  assert.match(r.output[0].text, /fly deploy/);

  const d = await del.execute({ name: "deploy-fly" }, api, {});
  assert.match(d.output[0].text, /deleted skill deploy-fly/);
  const gone = await read.execute({ name: "deploy-fly" }, api, {});
  assert.equal(gone.isError, true);
  rmSync(dir, { recursive: true, force: true });
});

test("jobs: start_job returns at once, job_wait captures exit code and log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobs-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const jobs = createJobs({ jobsDir: join(dir, ".jobs") });
  const start = jobs.tools.find((t) => t.name === "start_job");
  const wait = jobs.tools.find((t) => t.name === "job_wait");
  const status = jobs.tools.find((t) => t.name === "job_status");

  const api = { conversationId: 1, env, taskId: "t1", callId: "c1", commit: async (fn) => fn({ doc: () => ({ jobs: {} }) }) };
  const s = await start.execute({ command: `echo hello-job > ${join(dir, "marker.txt")} && sleep 0.2 && exit 0`, label: "quick" }, api, {});
  const m = /job (\w+) started/.exec(s.output[0].text);
  assert.ok(m, s.output[0].text);
  const id = m[1];

  const w = await wait.execute({ jobId: id, timeoutSec: 15 }, api, {});
  const text = w.output[0].text;
  assert.match(text, /exit code 0/, text);
  const marker = await env.readTextFile(join(dir, "marker.txt"), {});
  assert.ok(marker.ok);
  assert.equal(marker.value.trim(), "hello-job");

  const st = await status.execute({ jobId: id }, api, {});
  assert.match(st.output[0].text, /done 0/);
  rmSync(dir, { recursive: true, force: true });
});
