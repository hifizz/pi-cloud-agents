// Skills (bdots idea 7): reusable method notes the bot writes for itself, stored as markdown files in the shared
// sandbox at ~/.skills/ so they survive server restarts and are readable by every bot (shared sandbox).
//
// `save_skill` / `list_skills` / `read_skill` / `delete_skill` tools run through the sandbox via api.env (the same
// ExecutionEnv the coding tools use), so no new trust boundary is opened. The preamble lists the known skill names
// and one-liners in a <skills> section so the model discovers them without a tool call.
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { runCapture } from "./capture.mjs";

/** Skills directory inside the sandbox (kept out of ~/workspace to avoid polluting git worktrees). */
export const SKILLS_DIR = "~/.skills";
const MAX_SKILLS = 50;
const MAX_BODY_CHARS = 20000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/** Validated skill name or throws. */
export function checkName(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!NAME_RE.test(n)) throw new Error(`invalid skill name "${name}": use lowercase letters, digits and dashes (max 64 chars)`);
  return n;
}

/** Parse the listing script output into [{name, summary}]; empty input -> []. */
export function parseListing(text) {
  const out = [];
  for (const block of String(text ?? "").split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const name = lines[0].replace(/\.md$/, "");
    if (!NAME_RE.test(name)) continue;
    const summary = lines.slice(1).join(" ").trim() || "(no summary)";
    out.push({ name, summary: summary.slice(0, 200) });
  }
  return out;
}

/** Listing script: file names plus the first non-heading line of each file, blank-line separated. */
export function listScript(dir) {
  return (
    `ls -1 ${q(dir)}/*.md 2>/dev/null | while read -r f; do ` +
    `echo "\${f##*/}"; grep -v '^#' "$f" 2>/dev/null | grep -m1 -v '^[[:space:]]*$' || true; echo; done`
  );
}

/**
 * @param {{ skillsDir?: string }} [opts]
 */
export function createSkills(opts = {}) {
  const dir = opts.skillsDir ?? SKILLS_DIR;
  const listing = listScript(dir);

  const requireEnv = (env) => {
    if (!env) throw new Error("skills need an execution environment (sandbox)");
    return env;
  };

  const saveSkill = defineTool({
    name: "save_skill",
    description:
      `Save a reusable method note as a markdown skill in ${dir}/<name>.md so future runs skip rediscovering it. ` +
      `Keep it under ${MAX_BODY_CHARS} characters: what it does, when to use it, the exact steps/commands. Saving again overwrites.`,
    parameters: Type.Object({
      name: Type.String({ description: "kebab-case-name" }),
      summary: Type.String({ description: "One line: what this skill does" }),
      body: Type.String({ description: "Markdown body of the skill" }),
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      const name = checkName(args.name);
      const body = String(args.body ?? "");
      if (!body.trim()) throw new Error("body is required");
      if (body.length > MAX_BODY_CHARS) throw new Error(`body too long (${body.length} > ${MAX_BODY_CHARS} chars)`);
      const env = requireEnv(api.env);
      const file = `${dir}/${name}.md`;
      const guard = await env.exec(
        `mkdir -p ${q(dir)} && { [ -f ${q(file)} ] || [ "$(ls -1 ${q(dir)}/*.md 2>/dev/null | wc -l)" -lt ${MAX_SKILLS} ]; }`,
        undefined,
        context,
      );
      if (!guard.ok) throw new Error(`cannot prepare skills dir: ${guard.error?.message ?? "unknown"}`);
      if (guard.value.exitCode !== 0) throw new Error(`too many skills (max ${MAX_SKILLS}); delete one first`);
      const w = await env.writeFile(file, `# ${name}\n\n${String(args.summary).trim()}\n\n${body}\n`, context);
      if (!w.ok) throw new Error(`cannot write skill: ${w.error?.message ?? "unknown"}`);
      return { output: [{ type: "text", text: `saved skill ${name} (${file})` }] };
    },
  });

  const listSkills = defineTool({
    name: "list_skills",
    description: "List saved skills with their one-line summaries.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api, context) {
      const env = requireEnv(api.env);
      const r = await runCapture(env, listing, context, { maxChars: 8000 });
      if (!r.ok) return { output: [{ type: "text", text: `no skills yet (${dir} is empty)` }] };
      const skills = parseListing(r.value);
      return { output: [{ type: "text", text: skills.map((s) => `- ${s.name}: ${s.summary}`).join("\n") || "no skills yet" }] };
    },
  });

  const readSkill = defineTool({
    name: "read_skill",
    description: "Read one saved skill's full markdown body.",
    parameters: Type.Object({ name: Type.String({ description: "Skill name" }) }),
    replay: "safe",
    async execute(args, api, context) {
      const name = checkName(args.name);
      const env = requireEnv(api.env);
      const r = await env.readTextFile(`${dir}/${name}.md`, context);
      if (!r.ok) return { output: [{ type: "text", text: `skill not found: ${name}` }], isError: true };
      return { output: [{ type: "text", text: r.value }] };
    },
  });

  const deleteSkill = defineTool({
    name: "delete_skill",
    description: "Delete a saved skill.",
    parameters: Type.Object({ name: Type.String({ description: "Skill name" }) }),
    replay: "unsafe",
    async execute(args, api, context) {
      const name = checkName(args.name);
      const env = requireEnv(api.env);
      const r = await env.remove(`${dir}/${name}.md`, undefined, context);
      if (!r.ok) return { output: [{ type: "text", text: `skill not found: ${name}` }], isError: true };
      return { output: [{ type: "text", text: `deleted skill ${name}` }] };
    },
  });

  return defineExtension({
    name: "tarsbot.skills",
    tools: [saveSkill, listSkills, readSkill, deleteSkill],
    sections: [
      section("skills", async (input, context) => {
        if (!input.env) return undefined;
        const r = await runCapture(input.env, listing, context, { maxChars: 8000 });
        if (!r.ok) return undefined;
        const skills = parseListing(r.value);
        if (skills.length === 0) return undefined;
        return [
          `- Skills you (or another bot) saved for reuse, in ${dir}. Read one with the read_skill tool before reusing it:`,
          ...skills.map((s) => `  - ${s.name}: ${s.summary}`),
        ].join("\n");
      }),
    ],
  });
}

export const Skills = createSkills();
