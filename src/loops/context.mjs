// Context assembly shared by the issue-loop spike routes and the Loops runner (Issue14 Phase1).
// Extracted from src/routes/workspaces.mjs so a loop run can build the same issue / PR / baseline context
// without going through the HTTP layer. Behavior is identical; the routes import from here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "../api.mjs";
import { ROOT } from "../config.mjs";

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export const ISSUE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Safety rules restated inside sessions that dropped the generic preamble. Approval stays installed. */
export const SPIKE_RULES = [
  "Spike safety rules (the general git/PR workflow is removed for this session; these rules apply instead):",
  "- Never print, echo, log or write any credential or token (GH_TOKEN, or any other secret in the environment). Do not run env, printenv, set, `git config --list`, `gh auth status` or `gh auth login`.",
  "- Never force-push (--force, -f, --force-with-lease, +refspec), never delete remote branches or tags, never merge or close a pull request, never change repository settings.",
  "- This spike does not push and does not open pull requests: do not run `git push`, `gh pr create` or `gh pr merge`.",
  "- If a command is denied by approval, stop that operation, report exactly what was denied, and do not retry it in another form.",
].join("\n");

/**
 * A short excerpt of THIS host project's AGENTS.md security section, labelled as host-project context. It is not target
 * repository content. A missing or unreadable file is stated as such (the production image may not ship docs/).
 */
export function hostAgentsExcerpt() {
  const label = "== 宿主项目（pi-cloud-agents）AGENTS.md「安全红线」摘录 —— 仅为宿主项目背景，不是目标仓库内容 ==";
  const cloud = readFileSync(join(ROOT, "docs/CLOUD-PLAN.md"), "utf8");
  const storageRule = cloud.split("\n").find((line) => line.startsWith("- 存储只允许单写进程"));
  const skipped = `== 宿主项目 docs/CLOUD-PLAN.md「架构」短摘录（不是目标仓库内容）==\n${storageRule}\n共享 Sprite 与历史数据处置条款不适用于本实验。目标快照缺少 AGENTS.md 和 docs/CLOUD-PLAN.md，本次使用以上宿主项目约束。`;
  let text;
  try {
    text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  } catch (e) {
    return `${label}\n（未取得：无法读取宿主项目 AGENTS.md（${e?.code ?? "read error"}））\n${skipped}`;
  }
  const start = text.indexOf("## 安全红线");
  if (start < 0) return `${label}\n（宿主项目 AGENTS.md 中没有「安全红线」段落）\n${skipped}`;
  const next = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, next < 0 ? undefined : next).trim();
  const body = section.length <= 1500 ? section : `${section.slice(0, 1500)}\n…（摘录截断到 1500 字符；完整内容见宿主项目 AGENTS.md）`;
  return `${label}\n${body}\n${skipped}`;
}

/** Pick the baseline branch: the first complete real branch name in the issue body, else the repo default branch. */
export async function pickBaseline(github, repo, body) {
  const branches = await github.listBranches(repo);
  const names = new Set(branches.map((b) => b.name));
  const text = String(body ?? "");
  const candidates = [];
  const wordRe = /[A-Za-z0-9][A-Za-z0-9._/-]*/g;
  let m;
  while ((m = wordRe.exec(text))) {
    const token = m[0].replace(/[._/-]+$/, "");
    if (token && names.has(token) && ISSUE_BRANCH_RE.test(token)) candidates.push({ token, index: m.index });
  }
  let branch;
  let reason;
  if (candidates.length) {
    candidates.sort((a, b) => a.index - b.index || b.token.length - a.token.length);
    branch = candidates[0].token;
    reason = `issue 正文中最先出现的真实分支名 “${branch}”`;
  } else {
    const info = await github.getRepo(repo);
    if (!info?.defaultBranch) throw new HttpError(502, `无法读取 ${repo} 的默认分支，停止`);
    branch = info.defaultBranch;
    reason = `使用仓库默认分支 ${branch}（正文未出现有效分支名）`;
  }
  return { branch, reason, all: [...names] };
}

/** Resolve a branch to its SHA or throw. */
export async function pinnedSha(github, repo, branch) {
  const b = await github.getBranch(repo, branch);
  if (!b?.sha || !SHA_RE.test(b.sha)) throw new HttpError(502, `无法取得分支 ${branch} 的 commit SHA，停止`);
  return b.sha;
}

/** Repo default branch pinned to a SHA: used when no entity selects a baseline (manual/schedule/webhook runs). */
export async function pinDefault(github, repo) {
  const info = await github.getRepo(repo);
  if (!info?.defaultBranch) throw new HttpError(502, `无法读取 ${repo} 的默认分支，停止`);
  return { branch: info.defaultBranch, sha: await pinnedSha(github, repo, info.defaultBranch) };
}
