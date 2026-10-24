// GET /api/space — where the Bot's computer lives: { sandbox: "sprites" | "e2b" | "instabox", name, cwd }.
import { config } from "../config.mjs";
import { loadSandbox } from "../sandbox/index.mjs";

export function register(app) {
  app.get("/api/space", async () => {
    const { info } = await loadSandbox();
    return { ...info(), cwd: config.spaceCwd };
  });
}
