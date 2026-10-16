import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { SpaceInfo } from "../types";

/** Fallback when the server does not report `cwd` (config.spaceCwd). */
const SPRITE_WORKDIR = "/home/sprite/workspace";

export function EnvironmentPane() {
  const [info, setInfo] = useState<SpaceInfo>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .space()
      .then((s) => alive && setInfo(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <aside aria-label="Environment" className="w-64 shrink-0 border-l border-zinc-800">
      <div className="border-b border-zinc-800 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Environment</h2>
      </div>
      {info ? (
        <dl className="m-3 space-y-2 rounded border border-zinc-800 bg-zinc-900/50 p-3 text-sm" data-testid="sprite-card" data-sandbox={info.sandbox}>
          <div>
            <dt className="text-xs text-zinc-500">执行环境</dt>
            <dd className="text-zinc-200">
              {info.sandbox === "e2b" ? "E2B" : "Sprite"} <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">{info.name ?? "(未配置)"}</code>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">工作目录</dt>
            <dd>
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200">{info.cwd ?? SPRITE_WORKDIR}</code>
            </dd>
          </div>
        </dl>
      ) : (
        <p className="p-4 text-sm text-zinc-500">{failed ? "执行环境信息不可用" : "加载中…"}</p>
      )}
    </aside>
  );
}
