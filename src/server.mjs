// Production entry: harness + bots + API + static web UI.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, config } from "./config.mjs";
import { ctx } from "./harness.mjs";
import { BotRegistry } from "./bots.mjs";
import { bootstrap } from "./runtime.mjs";
import { createApi } from "./api.mjs";

/** Dynamically import every src/routes/*.mjs (each exports register(app)). */
export async function loadRoutes(dir = join(ROOT, "src", "routes")) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (typeof mod.register === "function") out.push(mod.register);
    else console.warn(`routes/${file}: no register(app) export, skipped`);
  }
  return out;
}

export async function main() {
  const { harness } = await bootstrap();
  console.log("resume done");
  const bots = new BotRegistry(harness);
  if (bots.list().length === 0) await bots.createBot({ name: "tars" });

  const api = createApi({ harness, bots, staticDir: join(ROOT, "web", "dist"), routes: await loadRoutes() });
  const { port } = await api.listen(config.port, config.host);
  console.log(`TARSBot listening on http://${config.host}:${port}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    try {
      await api.close();
      await harness.close(ctx);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("fatal:", e?.stack ?? e);
    process.exit(1);
  });
}
