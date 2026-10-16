// GET /api/space — where the Bot's computer lives: { sandbox: "sprites", name }.
import { getSpriteInfo } from "../sandbox/sprites.mjs";

export function register(app) {
  app.get("/api/space", async () => getSpriteInfo());
}
