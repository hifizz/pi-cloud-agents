// WP0 probe: create/connect a Space, run bash, list driver tools, take a screenshot.
import { writeFileSync, mkdirSync } from "node:fs";
import { embedded, SpaceCreateOptions } from "@trycua/cua";

const t0 = Date.now();
const spaces = embedded().spaces();
console.log("existing spaces:", JSON.stringify(await spaces.list(), (k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 800));

const created = await spaces.create(SpaceCreateOptions.create({ reuse: true, env: new Map(), services: new Map(), name: "tarsbot-probe" }));
console.log("created:", JSON.stringify(created, (k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 1200));
const id = created.space?.id ?? created.id;
const space = await spaces.space(id);
console.log(`space ${id} ready in ${Date.now() - t0}ms`);

const u = await space.bash("uname -a && whoami && echo HOME=$HOME && pwd", undefined);
console.log("bash:", u);

mkdirSync("docs", { recursive: true });
const tools = await space.listTools("driver");
writeFileSync("docs/driver-tools.txt", JSON.stringify(tools, (k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
console.log("driver tools:", (Array.isArray(tools) ? tools : JSON.parse(tools)).map?.((t) => t.name ?? t).join(", "));
