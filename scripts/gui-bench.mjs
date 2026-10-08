// GUI success-rate benchmark (Task 15, TEST-F02-2/3).
// Usage: node scripts/gui-bench.mjs [--models glm-5.3-flash,claude-sonnet-5-5] [--modes A,B] [--levels L1,L2,L3]
//                                   [--runs 3] [--l2-runs 5] [--timeout 360] [--report-only]
// Runs model → mode → level, serially. Results are appended to bench/results.jsonl (resume: finished runs are skipped)
// and docs/gui-success.md is regenerated after every run.
// Needs the TARSBot server (with src/routes/bench.mjs) on TARSBOT_URL (default http://127.0.0.1:8080) and the Space
// container (default tarsbot-space). The Space site lives in /opt/bench; secrets are per-run and never served over HTTP.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.TARSBOT_URL ?? "http://127.0.0.1:8080";
const CONTAINER = process.env.TARSBOT_SPACE_CONTAINER ?? "tarsbot-space";
const SITE = "http://127.0.0.1:8765";
const RESULTS = join(ROOT, "bench", "results.jsonl");
const REPORT = join(ROOT, "docs", "gui-success.md");
const CONCLUSION = join(ROOT, "bench", "conclusion.md");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const MODELS = opt("models", "glm-5.3-flash,claude-sonnet-5-5").split(",");
const MODES = opt("modes", "A,B").split(",");
const LEVELS = opt("levels", "L1,L2,L3").split(",");
const RUNS = Number(opt("runs", 3));
const L2_RUNS = Number(opt("l2-runs", 5));
const TIMEOUT_S = Number(opt("timeout", 360));
const REPORT_ONLY = argv.includes("--report-only");

const TOOLS_A = ["desktop_screenshot", "desktop_windows", "desktop_launch", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll"];
const TOOLS = { A: TOOLS_A, B: [...TOOLS_A, "desktop_elements"] };
const MODES_ALL = ["A", "B"];
const MODE_NAME = { A: "A 仅截图", B: "B 截图+无障碍树" };
const INSTRUCTIONS = {
  A: "Benchmark run. The accessibility tool desktop_elements is NOT available: work from screenshots and click with desktop_click x/y (desktop screenshot pixels, scope \"desktop\"). You have no shell, file or web tools; use only the desktop. Ignore any advice above about desktop_elements.",
  B: "Benchmark run. You have no shell, file or web tools; use only the desktop_* tools.",
};

// ── Space helpers ───────────────────────────────────────────────────────────
function docker(args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const p = execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}
const sh = (cmd, opts) => docker(["exec", "-i", CONTAINER, "sh", "-c", cmd], opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function siteUp() {
  const r = await sh(`python3 -c "import urllib.request;print(urllib.request.urlopen('${SITE}/',timeout=3).status)"`);
  return r.code === 0 && r.stdout.trim() === "200";
}

async function deploySite() {
  await sh("mkdir -p /opt/bench && touch /opt/bench/events.jsonl");
  const cp = await docker(["cp", join(ROOT, "bench", "site", "server.py"), `${CONTAINER}:/opt/bench/server.py`]);
  if (cp.code !== 0) throw new Error(`docker cp failed: ${cp.stderr}`);
  // Always restart so the running server matches the deployed file.
  await sh("pkill -f '[o]pt/bench/server.py'; true");
  await sleep(500);
  await sh("test -f /opt/bench/state.json || echo '{\"l1_token\":\"-\",\"l2_user\":\"-\",\"l2_pass\":\"-\",\"l2_token\":\"-\",\"l3_order\":\"-\"}' > /opt/bench/state.json");
  await docker(["exec", "-d", CONTAINER, "sh", "-c", "exec python3 /opt/bench/server.py 8765 >/tmp/bench-site.log 2>&1"]);
  for (let i = 0; i < 20 && !(await siteUp()); i++) await sleep(500);
  if (!(await siteUp())) throw new Error("bench site did not start in the Space");
}

async function resetSpace(state) {
  // `[c]hromium` keeps pkill from matching this very shell command line.
  await sh("pkill -f '[c]hromium'; pkill -f '[f]irefox'; true");
  for (let i = 0; i < 20; i++) {
    const r = await sh("pgrep -f '[c]hromium' >/dev/null && echo alive || echo dead");
    if (r.stdout.trim() === "dead") break;
    await sleep(500);
  }
  await sh(
    "rm -f /home/cua/.config/chromium/Singleton* ; " +
      "sed -i 's/\"exit_type\":\"Crashed\"/\"exit_type\":\"Normal\"/' /home/cua/.config/chromium/Default/Preferences 2>/dev/null; true",
  );
  await sh("cat > /opt/bench/state.json && : > /opt/bench/events.jsonl", { input: JSON.stringify(state) });
}

async function readEvents() {
  const r = await sh("cat /opt/bench/events.jsonl");
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

// ── tasks ───────────────────────────────────────────────────────────────────
const tok = (prefix) => `${prefix}-${randomBytes(3).toString("hex").toUpperCase()}`;
const L3_TARGETS = [
  { id: "p02", query: "USB-C Cable 2m Black" },
  { id: "p06", query: "Wireless Mouse Silver" },
  { id: "p08", query: "Mechanical Keyboard Red Switch" },
  { id: "p03", query: "USB-C Cable 2m White" },
  { id: "p05", query: "Wireless Mouse Graphite" },
];

function makeTask(level, n) {
  const base = { l1_token: tok("AC"), l2_user: "agent", l2_pass: randomBytes(4).toString("hex"), l2_token: tok("CF"), l3_order: tok("ORD") };
  if (level === "L1") {
    return {
      state: base,
      prompt: `Open ${SITE}/l1.html in a web browser (Chromium) on your desktop. The page shows an access code. Reply with the exact code.`,
      judge: async (answer) => ({ ok: answer.includes(base.l1_token), expected: base.l1_token }),
    };
  }
  if (level === "L2") {
    return {
      state: base,
      prompt: `Open ${SITE}/l2.html in a web browser (Chromium) on your desktop and sign in with username "${base.l2_user}" and password "${base.l2_pass}". After a successful sign-in the page shows a confirmation code. Reply with the exact code.`,
      judge: async (answer) => {
        const ev = await readEvents();
        const logged = ev.some((e) => e.kind === "login" && e.ok);
        return { ok: logged && answer.includes(base.l2_token), expected: base.l2_token, note: logged ? "" : "no successful login on server" };
      },
    };
  }
  const target = L3_TARGETS[n % L3_TARGETS.length];
  return {
    state: base,
    prompt: `Open ${SITE}/l3.html in a web browser (Chromium) on your desktop. It is an office shop. Use the search box to find the product "${target.query}" (there are similar products — pick exactly this one), tick its checkbox, and press "Submit order". Reply with the order number shown on the result page.`,
    judge: async (answer) => {
      const ev = (await readEvents()).filter((e) => e.kind === "order");
      const last = ev.at(-1);
      const okSubmit = !!last && last.items.length === 1 && last.items[0] === target.id;
      return {
        ok: okSubmit && answer.includes(base.l3_order),
        expected: `${base.l3_order} (item ${target.id})`,
        note: last ? `server saw ${ev.length} submission(s), last items=${JSON.stringify(last.items)}` : "no submission on server",
      };
    },
  };
}

// ── bot run ─────────────────────────────────────────────────────────────────
async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function runBot(bot, prompt) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/bots/${bot.id}/stream`);
  const calls = [];
  const failures = [];
  let answer = "";
  let started = false;
  let timedOut = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  ws.on("message", (buf) => {
    const frame = JSON.parse(buf);
    if (frame.type !== "events") return;
    for (const e of frame.events) {
      if (e.type === "run_start") started = true;
      if (e.type === "tool_execution_start") calls.push(e.toolName);
      if (e.type === "message_end") {
        const m = e.entry?.model?.[0];
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          const t = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) answer = t;
        }
      }
      if (e.type === "task_failed") failures.push(`${e.kind}: ${String(e.message).slice(0, 200)}`);
      if (e.type === "run_end" && started) resolveDone();
    }
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const t0 = Date.now();
  await api(`/api/bots/${bot.id}/input`, { text: prompt });
  const timer = setTimeout(async () => {
    timedOut = true;
    try {
      await api(`/api/bots/${bot.id}/abort`, {});
    } catch {}
    setTimeout(resolveDone, 5000);
  }, TIMEOUT_S * 1000);
  await done;
  clearTimeout(timer);
  ws.close();
  return { answer: answer.trim(), calls, failures, timedOut, seconds: Math.round((Date.now() - t0) / 1000) };
}

async function botUsage(botId) {
  const u = await api("/api/usage");
  const entry = u.bots.find((b) => b.id === botId);
  let tokens = 0;
  let cost = 0;
  for (const m of Object.values(entry?.usage?.models ?? {})) {
    tokens += m.totalTokens ?? 0;
    cost += m.cost?.total ?? 0;
  }
  return { tokens, cost };
}

// ── results / report ────────────────────────────────────────────────────────
function loadResults() {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const pct = (ok, n) => (n ? `${Math.round((100 * ok) / n)}% (${ok}/${n})` : "–");
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function writeReport() {
  const rs = loadResults();
  const models = [...new Set(rs.map((r) => r.model))];
  const lines = [];
  lines.push("# GUI 成功率矩阵（Task 15 · TEST-F02-2 / F02-3）", "");
  lines.push(`最近更新：${new Date().toISOString()} · 共 ${rs.length} 次运行 · 单次超时 ${TIMEOUT_S}s`, "");
  lines.push(
    "任务：L1 打开页面读口令；L2 表单登录（服务端校验）后读确认码；L3 搜索指定商品→勾选→提交，读订单号（服务端核对提交内容）。",
    "模式：A = 仅截图（desktop_screenshot/windows/launch/click/type/key/scroll）；B = A + desktop_elements（AT-SPI 无障碍树）。两种模式均无 bash/read/write/edit/web_search。",
    "",
  );
  lines.push("## 成功率矩阵", "", "| 模型 | 模式 | L1 | L2 | L3 |", "|---|---|---|---|---|");
  for (const model of models) {
    for (const mode of MODES_ALL) {
      if (!rs.some((r) => r.model === model && r.mode === mode)) continue;
      const cell = (lv) => {
        const g = rs.filter((r) => r.model === model && r.mode === mode && r.level === lv);
        return pct(g.filter((r) => r.success).length, g.length);
      };
      lines.push(`| ${model} | ${MODE_NAME[mode]} | ${cell("L1")} | ${cell("L2")} | ${cell("L3")} |`);
    }
  }
  lines.push("", "## 汇总（每模型 × 模式）", "", "| 模型 | 模式 | 总成功率 | 平均耗时(s) | 平均工具调用 | 平均 tokens | 总成本(USD) |", "|---|---|---|---|---|---|---|");
  for (const model of models) {
    for (const mode of MODES_ALL) {
      const g = rs.filter((r) => r.model === model && r.mode === mode);
      if (!g.length) continue;
      const avg = (f) => Math.round(g.reduce((a, r) => a + f(r), 0) / g.length);
      lines.push(
        `| ${model} | ${MODE_NAME[mode]} | ${pct(g.filter((r) => r.success).length, g.length)} | ${avg((r) => r.seconds)} | ${avg((r) => r.calls.length)} | ${avg((r) => r.tokens)} | ${g.reduce((a, r) => a + r.cost, 0).toFixed(3)} |`,
      );
    }
  }
  lines.push("", "## 每次运行明细", "", "| # | 模型 | 模式 | 级别 | 结果 | 耗时(s) | 工具调用 | tokens | 成本(USD) | 备注 / 回答摘要 / 工具分布 |", "|---|---|---|---|---|---|---|---|---|---|");
  rs.forEach((r, i) => {
    const counts = {};
    for (const c of r.calls) counts[c.replace("desktop_", "")] = (counts[c.replace("desktop_", "")] ?? 0) + 1;
    const extra = [r.timedOut ? "超时" : "", r.failures?.length ? `错误: ${r.failures[0]}` : "", r.note ?? "", `答: ${(r.answer ?? "").slice(0, 100)}`].filter(Boolean).join(" · ");
    lines.push(
      `| ${i + 1} | ${r.model} | ${r.mode} | ${r.level} | ${r.success ? "✅" : "❌"} | ${r.seconds} | ${r.calls.length} | ${r.tokens} | ${r.cost.toFixed(4)} | ${esc(extra)} ${esc(JSON.stringify(counts))} |`,
    );
  });
  lines.push("", "## 结论", "", existsSync(CONCLUSION) ? readFileSync(CONCLUSION, "utf8").trim() : "（运行完成后填写）", "");
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, lines.join("\n"));
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  if (REPORT_ONLY) return writeReport();
  await api("/api/bench/health");
  await deploySite();
  mkdirSync(dirname(RESULTS), { recursive: true });

  for (const model of MODELS) {
    for (const mode of MODES) {
      for (const level of LEVELS) {
        const want = level === "L2" ? L2_RUNS : RUNS;
        for (let n = 0; n < want; n++) {
          const done = loadResults().some((r) => r.model === model && r.mode === mode && r.level === level && r.n === n);
          if (done) continue;
          const task = makeTask(level, n);
          await resetSpace(task.state);
          const name = `gb-${model}-${mode}-${level}-${n}-${Date.now().toString(36)}`;
          console.log(`▶ ${name}`);
          const bot = await api("/api/bench/bots", { name, modelId: model, tools: TOOLS[mode], instructions: INSTRUCTIONS[mode] });
          let run;
          try {
            run = await runBot(bot, task.prompt);
          } catch (e) {
            run = { answer: "", calls: [], failures: [`harness: ${e.message}`], timedOut: false, seconds: 0 };
          }
          await sleep(1500);
          const verdict = await task.judge(run.answer);
          const usage = await botUsage(bot.id).catch(() => ({ tokens: 0, cost: 0 }));
          const rec = {
            model, mode, level, n, botId: bot.id, botName: name, success: verdict.ok, expected: verdict.expected, note: verdict.note ?? "",
            answer: run.answer, calls: run.calls, failures: run.failures, timedOut: run.timedOut, seconds: run.seconds, ...usage,
            at: new Date().toISOString(),
          };
          appendFileSync(RESULTS, JSON.stringify(rec) + "\n");
          writeReport();
          console.log(`  ${rec.success ? "PASS" : "FAIL"} ${rec.seconds}s calls=${rec.calls.length} tokens=${rec.tokens} cost=${rec.cost.toFixed(4)} ${rec.note}`);
        }
      }
    }
  }
  await resetSpace({ l1_token: "-", l2_user: "-", l2_pass: "-", l2_token: "-", l3_order: "-" });
  writeReport();
}

main().catch((e) => {
  console.error("bench failed:", e?.stack ?? e);
  process.exit(1);
});
