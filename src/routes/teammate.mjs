// Teammate routes: memory (idea 6), skills (7), jobs (15) read views for the UI panels.
//   GET /api/bots/:id/memory          → {bullets, revisions: [{rev, at}]}
//   GET /api/bots/:id/skills          → [{name, summary}] (from the sandbox, via routes/space primitives)
//   GET /api/jobs                     → all background jobs (session doc)
// Guarded by routes/auth.mjs.
import { HttpError } from "../api.mjs";
import { MemoryDoc, MemoryRevisionsDoc } from "../ext/memory.mjs";
import { parseListing, SKILLS_DIR } from "../ext/skills.mjs";
import { JobsDoc } from "../ext/jobs.mjs";
import { ctx } from "../harness.mjs";

const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const LISTING = `ls -1 ${q(SKILLS_DIR)}/*.md 2>/dev/null | while read -r f; do echo "\${f##*/}"; grep -v '^#' "$f" 2>/dev/null | grep -m1 -v '^[[:space:]]*$' || true; echo; done`;

export function register(app) {
  const { harness, bots } = app.ctx;

  app.get("/api/bots/:id/memory", async (_req, _res, { params }) => {
    const bot = bots.get(params.id);
    if (!bot) throw new HttpError(404, `bot not found: ${params.id}`);
    const doc = await harness.snapshot(MemoryDoc, bot.conversationId, ctx);
    const revs = await harness.snapshot(MemoryRevisionsDoc, ctx);
    const per = revs?.conversations?.[String(bot.conversationId)] ?? [];
    return {
      bullets: doc?.bullets ?? [],
      chars: (doc?.bullets ?? []).join("\n").length,
      revisions: per.map((r) => ({ rev: r.rev, at: r.at, count: r.bullets.length })),
    };
  });

  app.get("/api/bots/:id/skills", async (_req, _res, { params }) => {
    const bot = bots.get(params.id);
    if (!bot) throw new HttpError(404, `bot not found: ${params.id}`);
    // Skills live in the shared sandbox: read via the space route's bash. Failing sandbox → empty list, not an error.
    try {
      const { loadSandbox } = await import("../sandbox/index.mjs");
      const { bash } = await loadSandbox();
      const r = await bash(LISTING, { timeoutMs: 30_000 });
      if (r.exitCode !== 0) return [];
      return parseListing(r.stdout ?? "");
    } catch {
      return [];
    }
  });

  app.get("/api/jobs", async () => {
    const doc = await harness.snapshot(JobsDoc, ctx);
    return Object.values(doc?.jobs ?? {}).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  });
}
