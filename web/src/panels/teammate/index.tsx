// Teammate panel (ideas 6/7/8/15): the selected Bot's memory bullets, saved skills, webhook URL and background jobs.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { BotMemory, BotSummary, HookItem, JobItem, SkillItem } from "../../types";
import type { PanelContext, PanelDefinition } from "../types";

const section = "mb-4";
const heading = "text-xs font-semibold uppercase tracking-wide text-fg-dim";

function MemorySection({ bot }: { bot: BotSummary }) {
  const [mem, setMem] = useState<BotMemory>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      setMem(await api.botMemory(bot.id));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [bot.id]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);
  return (
    <section className={section} aria-label="Memory">
      <h3 className={heading}>Memory ({mem?.chars ?? 0}/8000 chars)</h3>
      {error && <p className="text-xs text-bad">{error}</p>}
      {!error && (mem?.bullets.length ?? 0) === 0 && <p className="text-xs text-fg-dim">Nothing remembered yet.</p>}
      <ul className="mt-1 space-y-1">
        {(mem?.bullets ?? []).map((b, i) => (
          <li key={i} className="text-xs text-fg">
            • {b}
          </li>
        ))}
      </ul>
      {(mem?.revisions.length ?? 0) > 0 && (
        <p className="mt-1 text-[10px] text-fg-dim">{mem!.revisions.length} revision(s) kept (restore via restore_revision)</p>
      )}
    </section>
  );
}

function SkillsSection({ bot }: { bot: BotSummary }) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .botSkills(bot.id)
      .then((s) => alive && setSkills(s))
      .catch(() => alive && setSkills([]));
    return () => {
      alive = false;
    };
  }, [bot.id]);
  return (
    <section className={section} aria-label="Skills">
      <h3 className={heading}>Skills (sandbox ~/.skills)</h3>
      {skills.length === 0 && <p className="text-xs text-fg-dim">No saved skills yet.</p>}
      <ul className="mt-1 space-y-1">
        {skills.map((s) => (
          <li key={s.name} className="text-xs">
            <span className="font-mono text-accent">{s.name}</span> <span className="text-fg-dim">— {s.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HookSection({ bot }: { bot: BotSummary }) {
  const [hook, setHook] = useState<HookItem>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const hooks = await api.listHooks();
        if (alive) setHook(hooks.find((h) => String(h.conversationId) === String(bot.conversationId)));
      } catch {
        /* auth or transient — the mint button below surfaces errors */
      }
    })();
    return () => {
      alive = false;
    };
  }, [bot.conversationId]);
  const mint = async () => {
    setError(undefined);
    try {
      const minted = await api.mintHook(bot.id);
      setHook({ conversationId: bot.conversationId, token: minted.token, createdAt: Date.now(), lastDeliveryAt: null, deliveries: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const origin = globalThis.location?.origin ?? "";
  return (
    <section className={section} aria-label="Webhook">
      <h3 className={heading}>Reach this Bot (webhook)</h3>
      {hook ? (
        <div className="mt-1 text-xs">
          <code className="block break-all rounded bg-black/30 p-1 font-mono text-[11px] text-fg">
            POST {origin}/api/hooks/{bot.id}/{hook.token}?source=github
          </code>
          <p className="mt-1 text-[10px] text-fg-dim">
            {hook.deliveries} delivery(ies); last {hook.lastDeliveryAt ? new Date(hook.lastDeliveryAt).toLocaleString() : "never"}
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void mint()}
          className="mt-1 rounded border border-accent/60 px-2 py-0.5 text-xs hover:bg-accent/20"
        >
          Create webhook URL
        </button>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}

function JobsSection() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .listJobs()
        .then((j) => alive && setJobs(j))
        .catch(() => {});
    void tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return (
    <section className={section} aria-label="Background jobs">
      <h3 className={heading}>Background jobs (all Bots)</h3>
      {jobs.length === 0 && <p className="text-xs text-fg-dim">No jobs.</p>}
      <ul className="mt-1 space-y-1">
        {jobs.slice(0, 10).map((j) => (
          <li key={j.id} className="text-xs">
            <span className={j.status === "done" ? "text-ok" : j.status === "error" ? "text-bad" : "text-warn"}>●</span>{" "}
            <span className="font-mono">{j.id}</span> <span className="text-fg-dim">{j.label ?? j.command.slice(0, 60)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const TeammatePanel = ({ bot }: PanelContext) => {
  if (!bot) return <p className="p-4 text-xs text-fg-dim">No Bot selected.</p>;
  return (
    <div className="h-full overflow-y-auto p-4">
      <MemorySection bot={bot} />
      <SkillsSection bot={bot} />
      <HookSection bot={bot} />
      <JobsSection />
    </div>
  );
};

export const teammatePanel: PanelDefinition = {
  id: "teammate",
  title: "Teammate",
  icon: "bulb",
  Component: TeammatePanel,
};
