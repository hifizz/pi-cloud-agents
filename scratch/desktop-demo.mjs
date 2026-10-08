// Mechanical pre-check for TEST-F02-1: drive the desktop tools directly (no model).
// launch Chromium -> example.com -> wait -> screenshot -> desktop_windows shows "Example Domain".
// Usage: node scratch/desktop-demo.mjs
import { writeFileSync } from "node:fs";
import { createDesktopTools } from "../src/ext/desktop.mjs";
import { spaceBash } from "../src/space.mjs";
import { ctx } from "../src/harness.mjs";

const tools = Object.fromEntries(createDesktopTools().map((t) => [t.name, t]));
const call = (name, args = {}) => tools[name].execute(args, {}, ctx);
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(label, fn) {
  const t0 = Date.now();
  const out = await fn();
  console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${label}`);
  return out;
}

// Clean start: close browsers left over from earlier probes (the container itself is untouched).
await step("close existing browsers", () => spaceBash("pkill -x chromium; pkill -x chrome; pkill -x firefox; sleep 1; true"));

const launched = await step("desktop_launch chromium https://example.com", () =>
  call("desktop_launch", { name: "chromium", urls: ["https://example.com"] }),
);
console.log("  ->", textOf(launched));

let title;
await step("wait for window titled 'Example Domain'", async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const line = textOf(await call("desktop_windows")).split("\n").find((l) => l.includes("Example Domain"));
    if (line) {
      title = line.trim();
      return;
    }
  }
});
if (!title) {
  console.error("FAIL: no window containing 'Example Domain' within 30s");
  process.exit(1);
}
await step("settle 2s", () => sleep(2000));

const shot = await step("desktop_screenshot", () => call("desktop_screenshot"));
const img = shot.content.find((c) => c.type === "image");
if (!img) {
  console.error("FAIL: screenshot returned no image");
  process.exit(1);
}
writeFileSync("scratch/demo-example.png", Buffer.from(img.data, "base64"));
console.log(`  -> saved scratch/demo-example.png (${Buffer.from(img.data, "base64").length} bytes)`);
console.log(textOf(shot).split("\n").map((l) => `  | ${l}`).join("\n"));

const wins = await step("desktop_windows", () => call("desktop_windows"));
const found = textOf(wins).split("\n").filter((l) => l.includes("Example Domain"));
console.log(found.map((l) => `  -> ${l.trim()}`).join("\n"));

// Bonus: the accessibility path (what a model would use).
const m = /window_id=(\d+) pid=(\d+) "Example Domain/.exec(found[0] ?? "");
if (m) {
  const els = await step("desktop_elements(query='Example Domain')", () =>
    call("desktop_elements", { pid: Number(m[2]), window_id: Number(m[1]), query: "Example Domain" }),
  );
  console.log(textOf(els).split("\n").slice(0, 8).map((l) => `  | ${l}`).join("\n"));
}

console.log(found.length ? "PASS: window title contains 'Example Domain'" : "FAIL");
process.exit(found.length ? 0 : 1);
