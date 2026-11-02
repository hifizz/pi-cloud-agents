// view_image tool behavior tests (offline): fake resolver + fake execEnv; no real Sprite, model or router.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewImage } from "../src/ext/view-image.mjs";
import { acceptsImageInput } from "../src/models.mjs";
import { withoutImageContent } from "../src/api.mjs";

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Resolver result double: runtimeBash returns the raw provider primitive ({stdout, stderr, exitCode}). */
function fakeEnv({ size = 100, b64 = TINY_PNG_BASE64, statError = "" } = {}) {
  const calls = [];
  return {
    calls,
    binding: { runtimeId: "pca-test", version: 1 },
    runtimeBash: async () => async (command) => {
      calls.push(command);
      if (command.startsWith("stat ")) {
        return statError
          ? { stdout: "", stderr: statError, exitCode: 1 }
          : { stdout: String(size), stderr: "", exitCode: 0 };
      }
      return { stdout: b64, stderr: "", exitCode: 0 };
    },
  };
}

const fakeApi = (modelId) => ({
  conversationId: 42,
  agent: async () => ({ model: { provider: "tokenrouter", modelId } }),
});
const context = { abortSignal: undefined };

async function run(resolved, args, { modelId = "gpt-5.6-terra" } = {}) {
  const ext = createViewImage({ resolve: () => resolved });
  return ext.tools[0].execute(args, fakeApi(modelId), context);
}

test("acceptsImageInput: catalog is the source of truth", () => {
  assert.equal(acceptsImageInput("gpt-5.6-terra"), true);
  assert.equal(acceptsImageInput("claude-sonnet-5-5"), true);
  assert.equal(acceptsImageInput("swe-2"), false);
  assert.equal(acceptsImageInput("glm-5.3"), false);
  assert.equal(acceptsImageInput("totally-unknown"), false);
});

test("view_image: vision model gets an ImageContent block", async () => {
  const out = await run(fakeEnv(), { path: "/home/sprite/workspace/shot.png" });
  assert.equal(out.isError, undefined);
  const text = out.output.find((p) => p.type === "text");
  const image = out.output.find((p) => p.type === "image");
  assert.match(text.text, /image .*image\/png/);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, TINY_PNG_BASE64);
});

test("view_image: text-only model (swe-2) gets a clear error, no bytes, no exec", async () => {
  let execCalled = false;
  const resolved = fakeEnv();
  resolved.runtimeBash = async () => {
    execCalled = true;
    throw new Error("should not exec");
  };
  const out = await run(resolved, { path: "/home/sprite/workspace/shot.png" }, { modelId: "swe-2" });
  assert.equal(out.isError, true);
  assert.match(out.output, /swe-2 不支持图像输入/);
  assert.equal(execCalled, false);
});

test("view_image: rejects unsupported extensions and non-absolute paths", async () => {
  await assert.rejects(run(fakeEnv(), { path: "/tmp/clip.mp4" }), /unsupported image type/i);
  await assert.rejects(run(fakeEnv(), { path: "relative.png" }), /absolute/i);
});

test("view_image: oversize image is rejected before the base64 read", async () => {
  const resolved = fakeEnv({ size: 5 * 1024 * 1024 });
  await assert.rejects(run(resolved, { path: "/tmp/big.png" }), /超过 .*MB 上限/);
  assert.ok(resolved.calls.every((c) => c.startsWith("stat ")), "no base64 exec for oversize files");
});

test("view_image: exec failure surfaces the primitive's stderr", async () => {
  const resolved = {
    binding: { runtimeId: "x", version: 1 },
    runtimeBash: async () => async () => ({ stdout: "", stderr: "binding replaced", exitCode: 3 }),
  };
  await assert.rejects(run(resolved, { path: "/tmp/a.png" }), /exit 3.*binding replaced/);
});

test("view_image: missing workspace binding throws (no fallback)", async () => {
  const ext = createViewImage({ resolve: () => undefined });
  await assert.rejects(ext.tools[0].execute({ path: "/tmp/a.png" }, fakeApi("gpt-5.6-terra"), context), /no active runtime binding/);
});

test("withoutImageContent: transcript serialization replaces image blocks with placeholders", () => {
  const entry = {
    type: "message",
    content: [
      { type: "text", text: "image /a.png (image/png, 0.1KB) attached" },
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
    ],
  };
  const out = withoutImageContent(entry);
  assert.equal(out.content[1].type, "text");
  assert.match(out.content[1].text, /\[image image\/png .*KB/);
  assert.ok(!JSON.stringify(out).includes(TINY_PNG_BASE64), "no base64 reaches the UI");
  assert.deepEqual(withoutImageContent({ a: [1, "x", null] }), { a: [1, "x", null] });
});
