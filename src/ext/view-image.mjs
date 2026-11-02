// view_image tool: read an image file from the conversation's workspace Sprite and attach it to the model
// context as an ImageContent block. pi-ai serializes it to an OpenAI `image_url` data part; pi-durable tool
// results natively carry single images. The model sees the pixels only when its catalog entry declares image
// input — for text-only models the tool returns a clear error instead of sending bytes the serializer would
// silently drop (openai-completions includes images only when model.input has "image").
//
// Resolution reuses Exec's resolver (conversation -> workspace -> binding -> runner): no second resolution
// path, no fallback to a local env. The image is read with one bounded `base64` exec; nothing is written.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { acceptsImageInput } from "../models.mjs";
import { config } from "../config.mjs";
import { execResolve } from "./exec.mjs";

/** Raw bytes cap: images travel base64 in model context AND the transcript store — keep them small. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MIME_BY_EXT = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
]);

const extOf = (p) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p).trim());
  return m ? m[1].toLowerCase() : "";
};

export function createViewImage(opts = {}) {
  const resolve = opts.resolve ?? ((target) => execResolve(target));

  const tool = defineTool({
    name: "view_image",
    description:
      "Read one image file (png/jpg/webp/gif, up to 2MB) from the workspace sandbox and attach it so you can see it. " +
      "Requires a vision-capable model; on a text-only model it returns an error. Use it for screenshots and photos " +
      "referenced in the task (download first with bash if the image is at a URL).",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path of the image file inside the workspace sandbox" }),
    }),
    replay: "safe", // re-reading a file after a restart re-runs the same read; no side effects
    async execute(args, api, context) {
      const path = String(args.path ?? "").trim();
      if (!path.startsWith("/")) throw new Error("path must be absolute inside the workspace sandbox");
      const ext = extOf(path);
      const mime = MIME_BY_EXT.get(ext);
      if (!mime) throw new Error(`unsupported image type ".${ext || "?"}": supported are png, jpg, jpeg, webp, gif`);

      const agent = await api.agent(context).catch(() => undefined);
      const modelId = agent?.model?.modelId ?? config.defaultModelId;
      if (!acceptsImageInput(modelId)) {
        return {
          isError: true,
          output: `当前模型 ${modelId} 不支持图像输入（文本模型）。图片无法被查看；请改用视觉模型（claude-sonnet-5-5、gpt-5.6-terra），或让用户描述图片内容。文件仍在沙箱：${path}`,
        };
      }

      const resolved = resolve({ conversationId: String(api.conversationId) });
      if (!resolved?.execEnv || !resolved?.binding) {
        throw new Error(`view_image 不可用：会话没有关联的工作区运行环境（no active runtime binding）`);
      }
      const run = async (command, timeoutSec) => {
        const r = await resolved.execEnv.exec(command, { timeout: timeoutSec }, context);
        if (r?.ok) return r.value; // {stdout, stderr, exitCode, timedOut}
        throw new Error(`view_image 执行失败：${String(r?.error?.message ?? r?.error ?? "unknown")}`);
      };

      const quoted = path.replace(/'/g, `'\\''`);
      const stat = await run(`stat -c %s '${quoted}'`, 15);
      const size = Number((stat.stdout ?? "").trim());
      if (!Number.isFinite(size) || size <= 0) throw new Error(`不是可读的文件（stat: ${String(stat.stdout ?? "").trim() || stat.stderr || "?"}）：${path}`);
      if (size > MAX_IMAGE_BYTES) {
        throw new Error(`图片 ${path} 为 ${(size / 1048576).toFixed(1)}MB，超过 ${MAX_IMAGE_BYTES / 1048576}MB 上限。请先用 bash 缩小（例如重新截图或降低分辨率）再查看。`);
      }
      const read = await run(`base64 -w0 '${quoted}'`, 60);
      const data = (read.stdout ?? "").replace(/\s+/g, "");
      if (!data) throw new Error(`base64 读取为空：${path}${read.stderr ? `（${read.stderr.slice(0, 120)}）` : ""}`);
      const kb = Math.round((size / 1024) * 10) / 10;
      return {
        output: [
          { type: "text", text: `image ${path} (${mime}, ${kb}KB) attached` },
          { type: "image", data, mimeType: mime },
        ],
      };
    },
  });

  return defineExtension({ name: "tarsbot.view-image", tools: [tool] });
}

export const ViewImage = createViewImage();
