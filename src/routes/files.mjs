// Files routes (AMP13-files): browse / read / upload inside the selected session's own working
// directory. All paths are resolved and confined server-side by src/files-env.mjs (realpath inside the
// session root, .env* / .git refused, size caps, no overwrite without `overwrite: true`). Nothing here
// trusts a client-supplied cwd, and errors never carry env values — the bash primitive already redacts.
//   GET  /api/bots/:id/files/list?path=<rel-or-abs>
//   GET  /api/bots/:id/files/read?path=<rel-or-abs>
//   POST /api/bots/:id/files/write  {path, base64, overwrite?}
// Registered only when app.ctx.bots + control + runtimeBash exist (same convention as other plugins).
import { HttpError } from "../api.mjs";
import { FileError } from "@earendil-works/pi-durable/env";
import { MAX_UPLOAD_BYTES, createFilesEnv } from "../files-env.mjs";

const MAX_PATH_CHARS = 2000;

/** FileError.code -> HTTP. Anything else becomes a 500 via the router's default. */
function mapFileError(e) {
  if (!(e instanceof FileError)) throw e;
  switch (e.code) {
    case "not_found":
      return new HttpError(404, e.message);
    case "conflict":
      return new HttpError(409, e.message);
    case "permission_denied":
      return new HttpError(403, e.message);
    case "is_directory":
    case "not_directory":
    case "invalid":
      return new HttpError(400, e.message);
    default:
      return new HttpError(500, e.message);
  }
}

/** Unwrap a {ok,value}|{ok:false,error} result into a value or HttpError. */
const unwrap = (r) => {
  if (r.ok) return r.value;
  throw mapFileError(r.error);
};

export function register(app) {
  const { bots, control, runtimeBash } = app.ctx;
  if (!bots || !control || typeof runtimeBash !== "function") {
    console.warn("routes/files: app.ctx.bots / control / runtimeBash is not set, file routes are not registered");
    return;
  }

  const envFor = async (botId) => {
    try {
      return await createFilesEnv(app, botId);
    } catch (e) {
      throw e instanceof FileError ? mapFileError(e) : e;
    }
  };

  function pathParam(query) {
    const p = query.path;
    if (p !== undefined && typeof p !== "string") throw new HttpError(400, "path must be a string");
    if (p !== undefined && p.length > MAX_PATH_CHARS) throw new HttpError(400, "path is too long");
    return p === undefined || p === "" ? "." : p;
  }

  app.get("/api/bots/:id/files/list", async (_req, _res, { params, query }) => {
    const env = await envFor(params.id);
    return unwrap(await env.list(pathParam(query)));
  });

  app.get("/api/bots/:id/files/read", async (_req, _res, { params, query }) => {
    const env = await envFor(params.id);
    return unwrap(await env.read(pathParam(query)));
  });

  app.post("/api/bots/:id/files/write", async (_req, _res, { params, body }) => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
    const p = body.path;
    if (typeof p !== "string" || !p.trim()) throw new HttpError(400, "path is required");
    if (p.length > MAX_PATH_CHARS) throw new HttpError(400, "path is too long");
    if (typeof body.base64 !== "string") throw new HttpError(400, "base64 is required");
    if (body.base64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 8) {
      throw new HttpError(413, `upload is larger than ${MAX_UPLOAD_BYTES} bytes`);
    }
    let bytes;
    try {
      bytes = new Uint8Array(Buffer.from(body.base64, "base64"));
    } catch {
      throw new HttpError(400, "base64 is not valid");
    }
    if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, `upload is larger than ${MAX_UPLOAD_BYTES} bytes`);
    const env = await envFor(params.id);
    return unwrap(await env.write(p.trim(), bytes, { overwrite: body.overwrite === true }));
  });
}
