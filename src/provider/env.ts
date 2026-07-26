/**
 * ExecutionEnv —— 执行环境抽象层
 *
 * 参考 PiAgent 的 ExecutionEnv 设计：把文件系统与 shell 抽象成统一接口，
 * 内置工具（read/write/bash）只依赖这个接口，而非直接调用 node:fs / child_process。
 *
 * 好处：
 * - 可测试：单测注入 MockEnv，无需真实文件系统
 * - 可移植：换 BrowserEnv / RemoteEnv / SandboxEnv 而工具代码不变
 * - 可沙盒：实现一个限制路径/命令的 env 即可加安全边界
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** shell 执行结果 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** 执行环境接口：文件系统 + shell */
export interface ExecutionEnv {
  /** 当前工作目录 */
  readonly cwd: string;
  /** 读取文本文件 */
  readTextFile(filePath: string, signal?: AbortSignal): Promise<string>;
  /** 写入文件（自动建父目录） */
  writeFile(filePath: string, content: string, signal?: AbortSignal): Promise<void>;
  /** 文件是否存在 */
  exists(filePath: string): Promise<boolean>;
  /** 列出目录 */
  listDir(dirPath: string): Promise<string[]>;
  /** 执行 shell 命令 */
  exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
}

/**
 * Node.js 环境实现。所有相对路径基于 cwd 解析。
 */
export class NodeExecutionEnv implements ExecutionEnv {
  readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  private resolve(filePath: string): string {
    return path.resolve(this.cwd, filePath);
  }

  async readTextFile(filePath: string, signal?: AbortSignal): Promise<string> {
    return fs.readFile(this.resolve(filePath), { encoding: "utf-8", signal });
  }

  async writeFile(filePath: string, content: string, signal?: AbortSignal): Promise<void> {
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, { encoding: "utf-8", signal });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async listDir(dirPath: string): Promise<string[]> {
    return fs.readdir(this.resolve(dirPath));
  }

  async exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, [], {
        shell: true,
        cwd: this.cwd,
        timeout: options?.timeout,
        signal: options?.signal,
      });
      return { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", exitCode: 0 };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? err.message ?? String(error),
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  }
}
