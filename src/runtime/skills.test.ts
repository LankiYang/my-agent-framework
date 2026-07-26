import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillMarkdown, loadSkills, formatSkillsForPrompt } from "./skills.js";
import { createAgent } from "../api.js";
import type { ExecutionEnv, ExecResult } from "../provider/env.js";

test("parseSkillMarkdown: 解析 frontmatter 与正文", () => {
  const raw = `---
name: debug-guide
description: 调试指南，遇到 bug 时参考
---
# 调试步骤
1. 复现
2. 定位`;
  const skill = parseSkillMarkdown(raw);
  assert.ok(skill);
  assert.equal(skill!.name, "debug-guide");
  assert.equal(skill!.description, "调试指南，遇到 bug 时参考");
  assert.match(skill!.content, /调试步骤/);
});

test("parseSkillMarkdown: 缺少 name/description 视为无效", () => {
  assert.equal(parseSkillMarkdown("# 无 frontmatter"), null);
  assert.equal(parseSkillMarkdown("---\nname: x\n---\nbody"), null); // 缺 description
});

// Mock env：提供一个技能目录结构
class SkillEnv implements ExecutionEnv {
  readonly cwd = "/mock";
  private files: Record<string, string>;
  private dirs: Record<string, string[]>;
  constructor(files: Record<string, string>, dirs: Record<string, string[]>) {
    this.files = files;
    this.dirs = dirs;
  }
  async readTextFile(p: string): Promise<string> {
    if (!(p in this.files)) throw new Error(`no file ${p}`);
    return this.files[p]!;
  }
  async writeFile(): Promise<void> {}
  async exists(p: string): Promise<boolean> {
    return p in this.files;
  }
  async listDir(p: string): Promise<string[]> {
    return this.dirs[p] ?? [];
  }
  async exec(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

test("loadSkills: 从子目录 SKILL.md 与顶层 .md 加载", async () => {
  const env = new SkillEnv(
    {
      "skills/debug/SKILL.md": "---\nname: debug\ndescription: 调试\n---\n调试正文",
      "skills/api.md": "---\nname: api\ndescription: API 用法\n---\nAPI 正文",
    },
    {
      skills: ["debug", "api.md"],
    },
  );
  const skills = await loadSkills("skills", env);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["api", "debug"]);
});

test("loadSkills: 目录不存在返回空", async () => {
  const env = new SkillEnv({}, {});
  const skills = await loadSkills("nonexistent", env);
  assert.deepEqual(skills, []);
});

test("formatSkillsForPrompt: 生成含 name/description 的块", () => {
  const block = formatSkillsForPrompt([
    { name: "s1", description: "用于任务A", content: "做A的步骤" },
  ]);
  assert.match(block, /<name>s1<\/name>/);
  assert.match(block, /用于任务A/);
  assert.match(block, /做A的步骤/);
});

test("createAgent: skills 注入 systemPrompt", () => {
  const agent = createAgent({
    name: "Skilled",
    model: {
      id: "m",
      async *generate() {
        yield { type: "end_turn" as const, stopReason: "end_turn" };
      },
    },
    prompt: "你是助手",
    skills: [{ name: "guide", description: "指南", content: "步骤" }],
  });
  assert.match(agent.systemPrompt, /你是助手/);
  assert.match(agent.systemPrompt, /available_skills/);
  assert.match(agent.systemPrompt, /guide/);
});
