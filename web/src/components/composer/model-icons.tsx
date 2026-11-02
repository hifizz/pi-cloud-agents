import type { IconType } from "@lobehub/icons";
import { Claude, OpenAI, Zhipu } from "@lobehub/icons";

/** Two-letter badge for models without a vendor logo (swe-2 是自家模型，沿用原徽章样式)。 */
const abbr = (model: string) => (model.split("/").pop() ?? model).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "M";

/** 模型 id → 厂商 logo；未映射的模型回落到两字母徽章。key 用 basename（不带 provider 前缀）。 */
const MODEL_LOGO: Record<string, IconType> = {
  "glm-5.3": Zhipu.Color,
  "glm-5.3-flash": Zhipu.Color,
  "claude-sonnet-5-5": Claude.Color,
  "gpt-5.6-terra": OpenAI,
};

/** 模型 logo：有厂商图标的用品牌色图标，否则渲染两字母徽章。 */
export function ModelIcon({ modelId, size = 16 }: { modelId: string; size?: number }) {
  const base = modelId.split("/").pop() ?? modelId;
  const Logo = MODEL_LOGO[base];
  if (Logo) return <Logo size={size} className="shrink-0" />;
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded bg-muted text-[8px] font-semibold text-foreground"
      style={{ width: size, height: size }}
    >
      {abbr(modelId)}
    </span>
  );
}
