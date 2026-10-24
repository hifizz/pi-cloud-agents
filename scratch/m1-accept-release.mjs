// Release ONE managed Sprite through provider.release (pca-* + app label only). Orchestrator acceptance helper.
//   node scratch/m1-accept-release.mjs <runtimeId>
import { SpritesClient } from "@fly/sprites";
import { createSpritesProvider } from "../src/providers/sprites.mjs";
process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
const provider = createSpritesProvider({ client: new SpritesClient(process.env.SPRITES_TOKEN) });
const id = process.argv[2];
console.log(JSON.stringify({ runtimeId: id, ...(await provider.release(id)) }));
