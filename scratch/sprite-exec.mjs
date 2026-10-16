// Run a command in the TARSBot Sprite through the production primitive (src/sandbox/sprites.mjs) or read its status.
// Used by scripts/sprites-kill-test.sh. Always start it as:  node --env-file=.env scratch/sprite-exec.mjs ...
// (the shell never reads or prints .env).
//
//   sprite-exec.mjs exec [--timeout-ms N] <command>   stdout/stderr of the command; exit code = command's (124 on timeout, 125 on SDK error)
//   sprite-exec.mjs status                            prints the platform status field (cold|warm|running|...) of the Sprite
//
// Safety: refuses to run unless TARSBOT_SPRITE_NAME is exactly "pi-cloud-agents". Everything printed is scrubbed of secrets.
import { spritesBash } from "../src/sandbox/sprites.mjs";

const NAME = "pi-cloud-agents";
if (process.env.TARSBOT_SPRITE_NAME !== NAME) {
  console.error(`refusing to run: TARSBOT_SPRITE_NAME must be exactly "${NAME}"`);
  process.exit(2);
}
const SECRETS = [process.env.SPRITES_TOKEN, process.env.GITHUB_TOKEN].filter((s) => typeof s === "string" && s.length >= 8);
const scrub = (s) => {
  let t = String(s ?? "");
  for (const v of SECRETS) t = t.split(v).join("<redacted>");
  return t.replace(/(github_pat_|ghp_|gho_|ghs_|ghu_)[A-Za-z0-9_]{10,}/g, "<redacted>");
};

const [mode, ...rest] = process.argv.slice(2);

if (mode === "status") {
  try {
    const { SpritesClient } = await import("@fly/sprites");
    const s = await new SpritesClient(process.env.SPRITES_TOKEN).getSprite(NAME);
    console.log(scrub(s.status));
  } catch (e) {
    console.error(scrub(`status error: ${e?.message ?? e}`).replace(/\?[^\s)]*/g, ""));
    process.exit(125);
  }
} else if (mode === "exec") {
  let timeoutMs;
  if (rest[0] === "--timeout-ms") {
    timeoutMs = Number(rest[1]);
    rest.splice(0, 2);
  }
  const command = rest.join(" ");
  if (!command) {
    console.error("usage: sprite-exec.mjs exec [--timeout-ms N] <command>");
    process.exit(2);
  }
  try {
    const r = await spritesBash(command, { timeoutMs });
    if (r.stdout) process.stdout.write(scrub(r.stdout));
    if (r.stderr) process.stderr.write(scrub(r.stderr));
    process.exit(r.timedOut ? 124 : r.exitCode);
  } catch (e) {
    console.error(scrub(`exec error: ${e?.message ?? e}`));
    process.exit(125);
  }
} else {
  console.error("usage: sprite-exec.mjs exec [--timeout-ms N] <command> | status");
  process.exit(2);
}
