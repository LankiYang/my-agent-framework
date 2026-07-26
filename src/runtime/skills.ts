/**
 * Skills（技能）系统
 *
 * 参考 PiAgent：技能是「何时用哪些工具/如何做某类任务」的声明式指导，
 * 存为带 YAML frontmatter 的 Markdown 文件（SKILL.md）。加能力无需改代码，
 * drop 一个文件即可；技能描述注入 system prompt，让模型自主决定何时读取。
 *
 * 与「工具」的区别：工具是可执行函数；技能是指导性知识（何时/如何调用工具）。
 */

import type { ExecutionEnv } from "../provider/env.js";

/** 一个技能 */
export interface Skill {
  /** 技能名（模型可见，唯一） */
  name: string;
  /** 描述：模型据此判断何时该用这个技能 */
  description: string;
  /** 完整指令正文（Markdown） */
  content: string;
  /** 来源文件路径（用于解析相对引用） */
  filePath?: string;
}

/**
 * 解析带 YAML frontmatter 的 Markdown。
 * 只支持简单的 key: value（name / description），足够技能元数据用。
 */
export function parseSkillMarkdown(raw: string, filePath?: string): Skill | null {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  let meta: Record<string, string> = {};
  let body = raw;
  if (fm) {
    body = fm[2] ?? "";
    for (const line of (fm[1] ?? "").split("\n")) {
      const kv = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
      if (kv) {
        meta[kv[1]!.trim()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  const name = meta.name?.trim();
  const description = meta.description?.trim();
  if (!name || !description) return null; // 缺元数据视为无效技能
  return { name, description, content: body.trim(), filePath };
}

/**
 * 从目录加载技能：优先读取每个子目录下的 SKILL.md，
 * 也加载目录顶层的 *.md。经 env 访问文件系统（可测试）。
 */
export async function loadSkills(dir: string, env: ExecutionEnv): Promise<Skill[]> {
  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = await env.listDir(dir);
  } catch {
    return skills; // 目录不存在，无技能
  }

  for (const entry of entries) {
    const full = `${dir}/${entry}`;
    // 子目录下的 SKILL.md
    const skillMd = `${full}/SKILL.md`;
    if (await env.exists(skillMd)) {
      const raw = await env.readTextFile(skillMd);
      const skill = parseSkillMarkdown(raw, skillMd);
      if (skill) skills.push(skill);
      continue;
    }
    // 顶层 .md 文件
    if (entry.endsWith(".md")) {
      try {
        const raw = await env.readTextFile(full);
        const skill = parseSkillMarkdown(raw, full);
        if (skill) skills.push(skill);
      } catch {
        // 跳过读取失败的文件
      }
    }
  }
  return skills;
}

/**
 * 把技能格式化为注入 system prompt 的文本块。
 * 只暴露 name + description（让模型知道有哪些技能、何时用），
 * 完整 content 由模型按需通过工具读取（此处也一并附上便于简单场景）。
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills
    .map(
      (s) =>
        `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<instructions>\n${s.content}\n</instructions>\n</skill>`,
    )
    .join("\n");
  return `以下技能提供了针对特定任务的专门指导，需要时请遵循对应技能的说明：\n<available_skills>\n${blocks}\n</available_skills>`;
}
