// M1-14 scenario 8b helper: start the server like src/server.mjs main(), but rebuild a workspace from a checkpoint
// AFTER workspaces.resumePending() and BEFORE harness.resume(). That reproduces "the server died mid-command, the Sprite
// was rebuilt, then the server came back": the interrupted bash call must meet binding v+1 and report "结果待确认".
//   TARSBOT_AUTH_DISABLED=1 TARSBOT_DATA_DIR=<dir> node scratch/m1-accept-rebuild-before-resume.mjs <workspaceId> <checkpointId>
import { join } from "node:path";
import { ROOT, config } from "../src/config.mjs";
import { assemble, loadRoutes } from "../src/server.mjs";
import { createApi } from "../src/api.mjs";

const [workspaceId, checkpointId] = process.argv.slice(2);
const parts = await assemble({
  hooks: {
    beforeResume: async ({ rebuild }) => {
      console.log(`rebuild ${workspaceId} from ${checkpointId} before the harness resumes ...`);
      const b = await rebuild({ workspaceId, checkpointId, requestId: `accept-8b-${Date.now()}` });
      console.log(`rebuilt: binding v${b.version} on ${b.runtimeId}`);
    },
  },
});
const api = createApi({ harness: parts.harness, bots: parts.bots, staticDir: join(ROOT, "web", "dist"), routes: await loadRoutes(), extraCtx: parts.ctxForApi });
const { port } = await api.listen(config.port, config.host);
console.log(`listening on ${port}`);
