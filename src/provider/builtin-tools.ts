/**
 * 内置工具集 —— read / write / bash
 *
 * 参考 PiAgent：工具不直接调用 node:fs / child_process，而是经 ExecutionEnv 访问系统。
 * 这样同一套工具能在 Node / 沙盒 / Mock 环境运行，且便于单测。
 *
 * 用法：createBuiltinTools(env?) 返回一组 ToolDef；或经 SharedContext.env 注入。
 */

import type { ToolDef, ToolInput, ToolOutput, SharedContext } from "../core/types.js";
import { NodeExecutionEnv, type ExecutionEnv } from "./env.js";

/** 从上下文取 env，缺省回退到基于 cwd 的 NodeExecutionEnv */
function resolveEnv(context: SharedContext, fallback?: ExecutionEnv): ExecutionEnv {
  return (context.env as ExecutionEnv | undefined) ?? fallback ?? new NodeExecutionEnv();
}

/** 输出截断上限（字符），防止大文件/大输出撑爆上下文 */
const MAX_OUTPUT_CHARS = 20_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, MAX_OUTPUT_CHARS);
  return `${head}\n\n[输出已截断，共 ${text.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS}]`;
}

/** read 工具：读取文本文件 */
export function createReadTool(env?: ExecutionEnv): ToolDef {
  return {
    name: "read",
    description: "读取文本文件内容。参数 path 为文件路径（相对工作目录或绝对路径）。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input: ToolInput, context: SharedContext): Promise<ToolOutput> {
      const e = resolveEnv(context, env);
      const p = String(input.path ?? "");
      try {
        const content = await e.readTextFile(p);
        return { content: truncate(content) };
      } catch (err) {
        return { content: `读取失败: ${(err as Error).message}` };
      }
    },
  };
}

/** write 工具：写入文件（非只读） */
export function createWriteTool(env?: ExecutionEnv): ToolDef {
  return {
    name: "write",
    description: "把内容写入文件（覆盖）。参数 path、content。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "文件内容" },
      },
      required: ["path", "content"],
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async execute(input: ToolInput, context: SharedContext): Promise<ToolOutput> {
      const e = resolveEnv(context, env);
      const p = String(input.path ?? "");
      try {
        await e.writeFile(p, String(input.content ?? ""));
        return { content: `已写入 ${p}` };
      } catch (err) {
        return { content: `写入失败: ${(err as Error).message}` };
      }
    },
  };
}

/** bash 工具：执行 shell 命令（非只读） */
export function createBashTool(env?: ExecutionEnv): ToolDef {
  return {
    name: "bash",
    description: "执行 shell 命令并返回 stdout/stderr。参数 command。",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    timeout: 60_000,
    async execute(input: ToolInput, context: SharedContext): Promise<ToolOutput> {
      const e = resolveEnv(context, env);
      const cmd = String(input.command ?? "");
      const result = await e.exec(cmd, { timeout: 60_000 });
      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
      if (result.exitCode !== 0) parts.push(`[exit ${result.exitCode}]`);
      return { content: truncate(parts.join("\n") || "(无输出)") };
    },
  };
}

/** 一次性创建全部内置工具 */
export function createBuiltinTools(env?: ExecutionEnv): ToolDef[] {
  return [createReadTool(env), createWriteTool(env), createBashTool(env)];
}
