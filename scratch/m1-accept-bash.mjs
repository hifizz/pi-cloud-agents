// Live check (orchestrator): the runner runs the user's command under bash on a REAL managed Sprite.
// Creates ONE temporary pca-* Sprite, runs bashism commands through the real runner client, then releases it.
//   node scratch/m1-accept-bash.mjs
import { SpritesClient } from "@fly/sprites";
import { createSpritesProvider } from "../src/providers/sprites.mjs";
import { createRunnerClient, runIdFor } from "../src/runner/client.mjs";
process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
const provider = createSpritesProvider({ client: new SpritesClient(process.env.SPRITES_TOKEN) });
const { runtimeId } = await provider.ensure({ requestId: `accept-bash-${Date.now()}`, workspaceId: "ws_accept_bash" });
console.log("sprite:", runtimeId, "managed:", provider.isManaged(runtimeId));
try {
  const runner = createRunnerClient({ bash: provider.bash(runtimeId) });
  console.log("install:", JSON.stringify(await runner.install()));
  const run = async (command, n) => {
    const id = runIdFor({ namespace: "accept-bash", generation: 1, taskId: n });
    await runner.prepare({ id, cwd: "/home/sprite", command });
    await runner.start(id);
    let from = 0, text = "", last;
    for (;;) {
      last = await runner.wait({ id, from, maxSeconds: 5 });
      text += last.text; from = last.offset;
      if (last.done) break;
    }
    return { exit: last.exit, text };
  };
  const bashisms = 'arr=(x y z); echo "arr=${arr[1]}"; [[ abc == a* ]] && echo dbl-bracket; echo {1..3}; diff <(echo 1) <(echo 1) && echo procsub; echo "BASH_VERSION=${BASH_VERSION:-none}"';
  const r = await run(bashisms, 1);
  console.log("exit:", r.exit);
  console.log(r.text.trim());
  const which = await run("readlink -f /bin/sh; ls -l /bin/bash | cut -c1-60", 2);
  console.log("sh ->", which.text.trim().split("\n")[0]);
} finally {
  console.log("release:", JSON.stringify(await provider.release(runtimeId)));
}
