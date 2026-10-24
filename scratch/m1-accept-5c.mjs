// M1-14 scenario 5c on a REAL Sprite: prepare a run (as Exec would), stop before start, then re-enter like a restarted
// Exec would. Uses the real runner client. Prints the runner states; never starts the command.
//   node scratch/m1-accept-5c.mjs <runtimeId>
import { SpritesClient } from "@fly/sprites";
import { createSpritesProvider } from "../src/providers/sprites.mjs";
import { createRunnerClient, runIdFor } from "../src/runner/client.mjs";
process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
const runtimeId = process.argv[2];
const provider = createSpritesProvider({ client: new SpritesClient(process.env.SPRITES_TOKEN) });
if (!provider.isManaged(runtimeId)) throw new Error("not a managed Sprite");
const runner = createRunnerClient({ bash: provider.bash(runtimeId) });
await runner.install();
const id = runIdFor({ namespace: "accept-5c", generation: 1, taskId: Date.now() });
const marker = `/tmp/pca-5c-marker-${id.slice(0, 6)}`;
const prepared = await runner.prepare({ id, cwd: "/home/sprite", command: `echo started > ${marker}` });
console.log("prepare ->", prepared.prepared, prepared.state);
console.log("(server 'killed' here: start is never called)");
const fresh = createRunnerClient({ bash: provider.bash(runtimeId) }); // a restarted server has a new client
console.log("status after restart ->", (await fresh.status(id)).state);
const w = await fresh.wait({ id, from: 0, maxSeconds: 1 });
console.log("wait after restart ->", w.state, "(done:", w.done, ")");
const again = await fresh.prepare({ id, cwd: "/home/sprite", command: `echo started > ${marker}` });
console.log("second prepare of the same id ->", again.prepared, "(must not be 'new')");
const check = await provider.bash(runtimeId)(`test -e ${marker} && echo MARKER-EXISTS || echo marker-absent`, { timeoutMs: 30000 });
console.log("command ever ran? ->", check.stdout.trim());
