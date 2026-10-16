// E1 probe: measure E2B platform behaviour on a TEMPORARY sandbox (metadata {app:"pi-cloud-agents", name:"probe-<ts>"}).
//   node --env-file=.env scratch/e2b-probe.mjs
// Writes docs/e2b-probe.md (raw measurements). The probe sandbox is always killed (finally + signal handlers) and the
// result is verified with Sandbox.list. Never touches name=pi-cloud-agents; never prints keys (everything is scrubbed).
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Sandbox } from "e2b";
import { createE2bBash } from "../src/sandbox/e2b.mjs";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) {
  console.error("E2B_API_KEY missing (run with --env-file=.env)");
  process.exit(2);
}
const PROBE = `probe-${Date.now()}`;
const META = { app: "pi-cloud-agents", name: PROBE };
const SECRETS = [apiKey, process.env.GITHUB_TOKEN].filter((s) => typeof s === "string" && s.length >= 8);
const scrub = (s) => {
  let t = String(s ?? "");
  for (const v of SECRETS) t = t.split(v).join("<redacted>");
  return t.replace(/(github_pat_|ghp_|gho_|ghs_|ghu_|e2b_)[A-Za-z0-9_]{10,}/g, "<redacted>");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const ms = (t0) => Math.round(now() - t0);

const md = [];
const say = (line = "") => {
  md.push(scrub(line));
  console.log(scrub(line));
};
const section = (t) => say(`\n## ${t}\n`);
const code = (s) => say("```\n" + String(s).trimEnd() + "\n```");
async function step(title, fn) {
  try {
    await fn();
  } catch (e) {
    say(`- ❌ **${title}** failed: \`${scrub(e?.name)}: ${scrub(e?.message).slice(0, 300)}\``);
  }
}

let sbx;
let killed = false;
async function cleanup() {
  if (killed) return;
  killed = true;
  try {
    if (sbx) await Sandbox.kill(sbx.sandboxId, { apiKey });
  } catch (e) {
    console.error("kill failed:", scrub(e?.message));
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => cleanup().finally(() => process.exit(130)));

async function listProbes() {
  const p = Sandbox.list({ apiKey, query: { metadata: { app: "pi-cloud-agents" } } });
  const items = [];
  do items.push(...(await p.nextItems()));
  while (p.hasNext);
  return items.filter((i) => i.metadata?.name?.startsWith("probe-"));
}

const IDLE = 120_000;
let bash;
const sh = async (cmd, o) => bash(cmd, o);

try {
  say(`# E2B 实测记录（E1-probe）\n\n脚本：\`scratch/e2b-probe.mjs\`，只操作临时沙箱 \`${PROBE}\`，结束时 kill 并核对无残留。SDK \`e2b@2.56.0\`，Node ${process.version}，日期 2026-10-16。`);

  // ------------------------------------------------------------------ create
  section("1. 创建 / 冷启动");
  await step("create", async () => {
    const t0 = now();
    sbx = await Sandbox.create("base", { apiKey, metadata: META, timeoutMs: 300_000, lifecycle: { onTimeout: "pause" } });
    say(`- Sandbox.create("base", {lifecycle:{onTimeout:"pause"}}) 冷启动：**${ms(t0)} ms**`);
    const info = await Sandbox.getInfo(sbx.sandboxId, { apiKey });
    say(`- getInfo：state=${info.state} cpu=${info.cpuCount} memoryMB=${info.memoryMB} templateId=${info.templateId} name=${info.name} envdVersion=${info.envdVersion}`);
    say(`- lifecycle=${JSON.stringify(info.lifecycle)}；startedAt→endAt = ${Math.round((new Date(info.endAt) - new Date(info.startedAt)) / 1000)} s`);
  });
  if (!sbx) throw new Error("no sandbox; aborting");
  bash = createE2bBash({ Sandbox, apiKey, name: PROBE, idleTimeoutMs: IDLE, env: { GH_TOKEN: "probe-gh-token-value" } });

  // ------------------------------------------------------------------ environment
  section("2. 环境");
  await step("env", async () => {
    const r = await sh(
      [
        "echo user=$(id -un) uid=$(id -u) home=$HOME pwd=$(pwd) shell=$SHELL",
        "echo '--- os'; grep PRETTY_NAME /etc/os-release; uname -srm",
        "echo '--- nproc'; nproc",
        "echo '--- free -m'; free -m",
        "echo '--- df -h ~'; df -h ~",
        "echo '--- sudo'; (sudo -n true && echo 'sudo: passwordless') 2>&1 || echo 'sudo: NO'",
        "echo '--- tools'; for t in git gh node npm python3 pip3 curl jq wget unzip tar make gcc rg sqlite3 ssh; do if command -v $t >/dev/null 2>&1; then printf '%s: ' $t; ($t --version 2>&1 | head -1); else echo \"$t: MISSING\"; fi; done",
        "echo '--- PATH'; echo $PATH",
        "echo '--- /sh'; ls -l /bin/sh",
        "echo '--- workspace'; ls -ld ~/workspace 2>&1 || echo 'no ~/workspace'",
      ].join("\n"),
    );
    code(r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ""));
  });

  // ------------------------------------------------------------------ GNU
  section("3. env.mjs 依赖的 GNU 行为");
  await step("gnu", async () => {
    const script = `
d=$(mktemp -d); cd "$d"; printf 'hello' > f; mkdir sub; ln -s f link
t() { name="$1"; shift; out=$("$@" 2>&1); rc=$?; printf '%-28s rc=%s  %s\\n' "$name" "$rc" "$(printf %s "$out" | head -c 120 | tr '\\n' ' ')"; }
t 'stat --printf'          stat --printf '%F|%s\\n' f
t "stat -c '%F|%s|%.3Y'"   stat -c '%F|%s|%.3Y' f
t 'base64 -w0'             sh -c 'base64 -w0 f'
t 'find -printf'           find . -mindepth 1 -printf '%P|%y|%s\\n'
t 'realpath -e'            realpath -e link
t 'realpath -e (missing)'  realpath -e nope
t 'mv -T'                  sh -c 'mkdir a b && mv -T a b && ls'
t 'truncate -c'            truncate -c -s 0 f
t 'truncate -c (missing)'  truncate -c -s 0 nofile
t 'mktemp --suffix'        mktemp --suffix=.txt
t 'sed --version'          sh -c 'sed --version | head -1'
t 'coreutils'              sh -c 'ls --version | head -1'
cd /; rm -rf "$d"
`;
    const r = await sh(script);
    code(r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ""));
  });

  // ------------------------------------------------------------------ latency
  section("4. 耗时");
  await step("latency", async () => {
    const runs = [];
    for (let i = 0; i < 6; i++) {
      const t0 = now();
      await sh("true", { timeoutMs: 30_000 });
      runs.push(ms(t0));
    }
    say(`- 经 createE2bBash 的单条命令（\`true\`）往返：首次（含 list+connect）${runs[0]} ms；之后（窗口内跳过 connect）${runs.slice(1).join(", ")} ms`);
    const conns = [];
    for (let i = 0; i < 4; i++) {
      const t0 = now();
      await Sandbox.connect(sbx.sandboxId, { apiKey, timeoutMs: IDLE });
      conns.push(ms(t0));
    }
    say(`- \`Sandbox.connect(id, {timeoutMs})\`（已运行）往返：${conns.join(", ")} ms`);
    const l = [];
    for (let i = 0; i < 3; i++) {
      const t0 = now();
      const p = Sandbox.list({ apiKey, query: { metadata: META } });
      await p.nextItems();
      l.push(ms(t0));
    }
    say(`- \`Sandbox.list(metadata)\` 往返：${l.join(", ")} ms`);
    const direct = [];
    for (let i = 0; i < 4; i++) {
      const t0 = now();
      await sbx.commands.run("true");
      direct.push(ms(t0));
    }
    say(`- SDK 直接 \`commands.run("true")\`（不经我们的封装）：${direct.join(", ")} ms`);
  });

  // ------------------------------------------------------------------ correctness
  section("5. 命令语义（引号 / 多行 / 退出码 / stdin）");
  await step("semantics", async () => {
    const cases = [
      ["exit 7", "exit 7"],
      ["stdout+stderr 分流", "echo out; echo err >&2"],
      ["单引号/双引号/$/反引号", `echo 'a'"'"'b' "c d" '$HOME' "$HOME" \`echo bt\``],
      ["多行 + heredoc", "cat <<'EOF'\nline1 $X\n  line2\nEOF\necho done"],
      ["未闭合引号（应为 sh 语法错误，退出码 2）", "echo 'unterminated"],
      ["结尾 # 注释", "echo hi # trailing comment"],
      ["sh 语义（非 bash）：`[[` 应报错", "[[ 1 == 1 ]] && echo bash-ism-worked || echo no"],
      ["$0 / 解释器", "echo $0; readlink /proc/$$/exe"],
      ["cat 无 stdin 输入（应立即 EOF）", "cat; echo after-cat"],
      ["UTF-8", "printf 'héllo 世界 🎉\\n'"],
      ["退出码 mod 256", "exit 300"],
      ["被信号杀死", "kill -9 $$"],
      ["cwd", "pwd"],
      ["超长单行 100 KB（argv 单元素上限附近）", "echo " + "a".repeat(100_000) + " | wc -c"],
    ];
    for (const [title, cmd] of cases) {
      const t0 = now();
      const r = await sh(cmd, { timeoutMs: 20_000 });
      say(`- **${title}** → exit=${r.exitCode} timedOut=${r.timedOut} ${ms(t0)}ms stdout=${JSON.stringify(r.stdout.slice(0, 160))} stderr=${JSON.stringify(r.stderr.slice(0, 160))}`);
    }
  });

  // ------------------------------------------------------------------ env
  section("6. envs 仅对单条命令生效");
  await step("envs", async () => {
    const a = await sh('printf "%s" "${GH_TOKEN:+set}"');
    say(`- 经 createE2bBash（env 含 GH_TOKEN）：命令内 GH_TOKEN ${a.stdout === "set" ? "**可见**" : "不可见"}`);
    const bare = createE2bBash({ Sandbox, apiKey, name: PROBE, idleTimeoutMs: IDLE });
    const b = await bare('printf "%s" "${GH_TOKEN:+set}"');
    say(`- 经另一个不带 env 的实例：GH_TOKEN ${b.stdout === "set" ? "**可见（泄漏到磁盘/全局环境！）**" : "不可见（不落盘、不跨命令）"}`);
    const c = await bare("grep -rIl probe-gh-token-value /home /etc /root /tmp 2>/dev/null | head -3; echo scan-done");
    say(`- 全盘（/home /etc /tmp）搜索 token 值：${JSON.stringify(c.stdout)}`);
  });

  // ------------------------------------------------------------------ big output
  section("7. 大输出 / 大命令");
  await step("big", async () => {
    for (const [label, bytes] of [["1 MB", 1_000_000], ["10 MB", 10_000_000]]) {
      const cmd = `head -c ${bytes} /dev/urandom | base64 -w0 | head -c ${bytes}; echo; echo \"$(head -c ${bytes} /dev/zero | wc -c)\" >&2`;
      const t0 = now();
      const r = await sh(cmd, { timeoutMs: 120_000 });
      say(`- stdout ${label}（base64 随机文本）：收到 ${r.stdout.length} 字符（期望 ${bytes + 1}），exit=${r.exitCode}，${ms(t0)} ms`);
    }
    // integrity: compare sha256 of a deterministic stream
    const t0 = now();
    const r = await sh(`yes 'abcdefghijklmnopqrstuvwxyz0123456789' | head -c 5000000 | tee /tmp/big.txt; echo; sha256sum /tmp/big.txt >&2`, { timeoutMs: 120_000 });
    const local = createHash("sha256").update(r.stdout.replace(/\n$/, "")).digest("hex");
    say(`- 5 MB 确定性文本完整性：收到 ${r.stdout.length}，本地 sha256 前缀 ${local.slice(0, 12)}，远端 ${r.stderr.slice(0, 12)}，${ms(t0)} ms`);
    const both = await sh(`head -c 2000000 /dev/zero | tr '\\0' a; head -c 2000000 /dev/zero | tr '\\0' b >&2`, { timeoutMs: 60_000 });
    say(`- 2 MB stdout + 2 MB stderr 并发：${both.stdout.length} / ${both.stderr.length}`);
    for (const kb of [50, 200, 1000]) {
      const filler = Array.from({ length: Math.ceil((kb * 1024) / 20) }, (_, i) => `: filler line ${String(i).padStart(6, "0")}`).join("\n");
      const script = `${filler}\necho script-ok-${kb}`;
      const t1 = now();
      const rr = await sh(script, { timeoutMs: 60_000 });
      say(`- ${kb} KB 脚本（经 createE2bBash，超 100 KB 自动改为上传文件执行；${script.length} 字节，${script.split("\n").length} 行）：stdout=${JSON.stringify(rr.stdout.trim())} exit=${rr.exitCode} ${ms(t1)} ms`);
    }
  });

  // ------------------------------------------------------------------ timeout
  section("8. 超时 kill");
  await step("timeout", async () => {
    const t0 = now();
    const r = await sh("echo $$ > /tmp/probe-pid; echo started; exec sleep 300", { timeoutMs: 4000 });
    say(`- timeoutMs=4000：返回耗时 ${ms(t0)} ms，timedOut=${r.timedOut}，stdout=${JSON.stringify(r.stdout)}`);
    await sleep(1500);
    const c = await sh("pid=$(cat /tmp/probe-pid); if kill -0 $pid 2>/dev/null; then echo ALIVE; else echo GONE; fi; pgrep -a sleep || echo no-sleep-procs");
    say(`- 1.5 s 后远端进程：${JSON.stringify(c.stdout.trim())}`);
    const t1 = now();
    const r2 = await sh("(sleep 300 &) ; sleep 300", { timeoutMs: 3000 });
    say(`- 带后台子进程的命令超时：timedOut=${r2.timedOut}，${ms(t1)} ms`);
    await sleep(1000);
    const c2 = await sh("pgrep -a sleep || echo no-sleep-procs");
    say(`- 之后残留 sleep 进程：${JSON.stringify(c2.stdout.trim())}（后台子进程不一定被 SIGKILL 主进程带走）`);
    await sh("pkill sleep; true");
    try {
      await sbx.commands.run("kill -9 $$");
    } catch (e) {
      say(`- 信号终止的原始 SDK 结果：name=${e.name} exitCode=${e.exitCode} error=${JSON.stringify(e.error)}`);
    }
    const raw = now();
    try {
      await sbx.commands.run("sleep 100", { timeoutMs: 3000 });
    } catch (e) {
      say(`- 对照：SDK \`commands.run("sleep 100",{timeoutMs:3000})\` ${ms(raw)} ms 后抛 \`${e.name}\``);
      await sleep(500);
      const c3 = await sh("pgrep -a sleep >/dev/null && echo STILL-RUNNING || echo gone");
      say(`  - SDK 超时后远端 sleep：${c3.stdout.trim()}（SDK 的前台命令超时会断开连接，envd 随之终止该进程；我们仍显式 kill）`);
      await sh("pkill sleep; true");
    }
    const def = now();
    const r3 = await sh("sleep 70; echo finished-after-70s", { timeoutMs: 100_000 });
    say(`- 不落到 SDK 默认 60 s：\`sleep 70\`（timeoutMs=100000）→ stdout=${JSON.stringify(r3.stdout.trim())} timedOut=${r3.timedOut} ${ms(def)} ms`);
  });

  // ------------------------------------------------------------------ pause/resume
  section("9. 暂停 / 恢复");
  await step("pause-explicit", async () => {
    await sh("echo persisted-$(date +%s) > ~/pause-test.txt; (sleep 600 >/dev/null 2>&1 &); echo $! >/dev/null");
    const before = (await sh("cat ~/pause-test.txt; pgrep sleep | head -1")).stdout;
    const t0 = now();
    const ok = await Sandbox.pause(sbx.sandboxId, { apiKey });
    say(`- 显式 \`Sandbox.pause(id)\`：返回 ${ok}，耗时 ${ms(t0)} ms`);
    const s1 = (await listProbes()).find((i) => i.metadata.name === PROBE);
    say(`- list 中状态：${s1?.state}`);
    const t1 = now();
    const r = await sh("cat ~/pause-test.txt; pgrep sleep | head -1; uptime", { timeoutMs: 30_000 });
    say(`- 暂停后经 createE2bBash 再调用：**透明恢复**，总耗时 ${ms(t1)} ms；文件与后台进程：${JSON.stringify(r.stdout)}（暂停前 ${JSON.stringify(before)}）`);
    const s2 = (await listProbes()).find((i) => i.metadata.name === PROBE);
    say(`- 恢复后 list 状态：${s2?.state}，endAt=${s2?.endAt?.toISOString?.()}`);
  });

  await step("pause-auto", async () => {
    // Shorten the timeout to trigger the lifecycle.onTimeout="pause" path. setTimeout() sets a new absolute timeout.
    await sh("echo auto-$(date +%s) > ~/auto-test.txt");
    await sbx.setTimeout(20_000, { requestTimeoutMs: 30_000 });
    const info = await Sandbox.getInfo(sbx.sandboxId, { apiKey });
    say(`- setTimeout(20000) 后 endAt 距现在 ${Math.round((new Date(info.endAt) - Date.now()) / 1000)} s`);
    const seen = [];
    const t0 = now();
    for (let i = 0; i < 20; i++) {
      await sleep(5000);
      const it = (await listProbes()).find((x) => x.metadata.name === PROBE);
      seen.push(`${Math.round((now() - t0) / 1000)}s:${it?.state ?? "gone"}`);
      if (it?.state !== "running") break;
    }
    say(`- 等待自动暂停，list 状态轨迹：${seen.join("  ")}`);
    // fresh bash instance: no cached sandbox / aliveUntil
    const fresh = createE2bBash({ Sandbox, apiKey, name: PROBE, idleTimeoutMs: IDLE });
    const t1 = now();
    const r = await fresh("cat ~/auto-test.txt ~/pause-test.txt", { timeoutMs: 30_000 });
    say(`- 自动暂停后全新 createE2bBash 实例首次调用（list→connect 恢复→run）：总 ${ms(t1)} ms，stdout=${JSON.stringify(r.stdout.trim())} exit=${r.exitCode}`);
    const t2 = now();
    await Sandbox.pause(sbx.sandboxId, { apiKey });
    say(`- 再次显式暂停 ${ms(t2)} ms；用已有实例（缓存 aliveUntil 仍有效）调用：`);
    const t3 = now();
    const r2 = await bash("echo still-works", { timeoutMs: 30_000 });
    say(`  - 结果 exit=${r2.exitCode} stdout=${JSON.stringify(r2.stdout.trim())} ${ms(t3)} ms（若失败，说明缓存窗口内被外部暂停时需靠一次重试恢复）`);
  });

  // ------------------------------------------------------------------ limits
  section("10. 账户限制");
  await step("limits", async () => {
    for (const [label, t] of [["1 h", 3_600_000], ["1 h + 1 s", 3_601_000], ["24 h", 86_400_000], ["25 h", 90_000_000]]) {
      try {
        await sbx.setTimeout(t, { requestTimeoutMs: 30_000 });
        const info = await Sandbox.getInfo(sbx.sandboxId, { apiKey });
        say(`- setTimeout(${label}) → 接受，endAt 距现在 ${Math.round((new Date(info.endAt) - Date.now()) / 60000)} 分钟`);
      } catch (e) {
        say(`- setTimeout(${label}) → 拒绝：\`${e.name}: ${scrub(e.message).slice(0, 200)}\``);
      }
    }
    await sbx.setTimeout(300_000, { requestTimeoutMs: 30_000 }).catch(() => {});
  });
} finally {
  section("11. 清理");
  await cleanup();
  try {
    await sleep(1500);
    const left = await listProbes();
    say(`- kill 后 \`Sandbox.list({metadata:{app}})\` 中 name=probe-* 的沙箱：${left.length} 个${left.length ? "（" + left.map((i) => `${i.metadata.name}:${i.state}`).join(", ") + "）" : "（无残留）"}`);
    const mine = left.filter((i) => i.metadata.name === PROBE);
    if (mine.length) {
      for (const i of mine) await Sandbox.kill(i.sandboxId, { apiKey }).catch(() => {});
      say("- 补发 kill 到残留的本次探测沙箱");
    }
  } catch (e) {
    say(`- 清理核对失败：${scrub(e?.message)}`);
  }
  writeFileSync(new URL("../docs/e2b-probe.md", import.meta.url), md.join("\n") + "\n");
}
