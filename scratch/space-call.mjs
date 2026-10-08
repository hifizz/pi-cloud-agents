// Probe callTool result shapes. Usage: node scratch/space-call.mjs <tool> '<json args>'
import { writeFileSync } from "node:fs";
import { embedded } from "@trycua/cua";

const [tool, args = "{}"] = process.argv.slice(2);
const spaces = embedded().spaces();
const list = await spaces.list();
const space = await spaces.space(list[0].id);
const raw = await space.callTool(tool, args, "driver", undefined);
const s = typeof raw === "string" ? raw : JSON.stringify(raw, (k, v) => (typeof v === "bigint" ? Number(v) : v));
writeFileSync(`scratch/${tool}.json`, s);
const j = JSON.parse(s);
const shrink = (v) => JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 200 ? `<${x.length} chars>` : x)).slice(0, 2500);
console.log(typeof raw, shrink(j));
