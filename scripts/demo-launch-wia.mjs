// Workspace-IA demo launcher: one-shot copy of the loops-acceptance data (sqlite backup API, sources opened
// read-only so the running 8090 service is untouched), then the CURRENT working tree's server on 127.0.0.1:8092.
// No secrets are printed; the server itself loads the original .env via its normal dotenv path.
import { DatabaseSync, backup } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = '/Users/zilin/side/pca-wia-demo';
const src = '/tmp/pca-loops-acceptance';
const dir = '/tmp/pca-wia-demo-data';
mkdirSync(dir, { recursive: true });

for (const name of ['auth.sqlite', 'control.sqlite', 'alice.sqlite']) {
  const target = `${dir}/${name}`;
  if (existsSync(target)) continue;
  const db = new DatabaseSync(`${src}/${name}`, { readOnly: true });
  await backup(db, target);
  db.close();
  console.log(`copied ${name}`);
}
if (!existsSync(`${dir}/bots.json`)) cpSync(`${src}/bots.json`, `${dir}/bots.json`);

process.env.TARSBOT_ALLOWED_EMAILS = `${process.env.TARSBOT_ALLOWED_EMAILS ?? ''},demo@localhost,env-demo@localhost`;
const { openAuthStore } = await import(pathToFileURL(`${root}/src/auth.mjs`));
const auth = openAuthStore({ dataDir: dir });
await auth.setPassword('demo@localhost', 'wia-demo-20261101');
auth.close();

const { assemble, loadRoutes } = await import(pathToFileURL(`${root}/src/server.mjs`));
const { createApi } = await import(pathToFileURL(`${root}/src/api.mjs`));
const parts = await assemble();
const api = createApi({ harness: parts.harness, bots: parts.bots, staticDir: `${root}/web/dist`, routes: await loadRoutes(), extraCtx: parts.ctxForApi });
await api.listen(8092, '127.0.0.1');
console.log('WIA-DEMO listening on http://127.0.0.1:8092 (copied data; current tree; no auto-created resources)');
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { if (closing) return; closing = true; await api.close(); await parts.close(); process.exit(0); });
