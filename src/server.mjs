// Production entry: harness + bots + API + static web UI.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, config } from "./config.mjs";
import { ctx } from "./harness.mjs";
import { BotRegistry } from "./bots.mjs";
import { bootstrap, productionExtensions } from "./runtime.mjs";
import { createApi } from "./api.mjs";
import { approvals } from "./ext/approval.mjs";

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
  const { harness, registry } = await bootstrap();
  console.log("resume done");
  const bots = new BotRegistry(harness);
  if (bots.list().length === 0) await bots.createBot({ name: "tars" });
  // Re-compose with the bot registry so message_bot / routine tools can reach other conversations.
  for (const ext of await productionExtensions({ harness, bots })) registry.install(ext);

  // sweepStuck (idea 4): remind after 4h, expire after 24h; the waiting approval hook resolves expired items as denied.
  const sweep = setInterval(() => {
    const { expired, reminded } = approvals.sweep();
    if (expired.length) console.log(`approvals expired (denied): ${expired.join(", ")}`);
    else if (reminded.length) console.log(`approvals waiting >4h: ${reminded.join(", ")}`);
  }, 15 * 60 * 1000);
  sweep.unref();

  const api = createApi({ harness, bots, staticDir: join(ROOT, "web", "dist"), routes: await loadRoutes() });
  const { port } = await api.listen(config.port, config.host);
  console.log(`TARSBot listening on http://${config.host}:${port}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    try {
      clearInterval(sweep);
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
