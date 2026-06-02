// ============================================================
// 工作空间/沙盒抽象层
// 提供统一的沙盒环境接口，支持本地和 Docker 两种实现
// ============================================================

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type {
  WorkspaceConfig,
  WorkspaceType,
  WorkspaceStatus,
  CommandResult,
  FileResult,
  FileOperation,
} from "../core/types.js";

const execFileAsync = promisify(execFile);

// ============================================================
// WorkspaceBase 抽象类
// ============================================================

/**
 * 工作空间/沙盒抽象基类
 * 定义了沙盒环境的标准接口，子类需实现所有抽象方法
 */
export abstract class WorkspaceBase {
  /** 工作空间配置 */
  public config: WorkspaceConfig;
  /** 当前状态 */
  public status: WorkspaceStatus;

  constructor(config: WorkspaceConfig) {
    this.config = config;
    this.status = "created";
  }

  /**
   * 初始化沙盒环境
   */
  abstract initialize(): Promise<void>;

  /**
   * 关闭沙盒环境
   */
  abstract close(): Promise<void>;

  /**
   * 在沙盒中执行命令
   * @param command 要执行的命令
   * @param timeout 超时时间（毫秒）
   */
  abstract execCommand(command: string, timeout?: number): Promise<CommandResult>;

  /**
   * 读取文件
   * @param path 文件路径
   */
  abstract readFile(path: string): Promise<FileResult>;

  /**
   * 写入文件
   * @param path 文件路径
   * @param content 文件内容
   */
  abstract writeFile(path: string, content: string): Promise<FileResult>;

  /**
   * 删除文件
   * @param path 文件路径
   */
  abstract deleteFile(path: string): Promise<FileResult>;

  /**
   * 列出目录内容
   * @param dir 目录路径
   */
  abstract listFiles(dir: string): Promise<FileResult>;

  /**
   * 检查文件是否存在
   * @param path 文件路径
   */
  abstract exists(path: string): Promise<FileResult>;

  /**
   * 检查沙盒是否正在运行
   */
  isRunning(): boolean {
    return this.status === "running";
  }

  /**
   * 检查文件访问权限
   * 基于 config.filesystem 配置校验路径是否允许操作
   * @param filePath 文件路径
   * @param operation 操作类型
   * @throws 如果操作不被允许则抛出 Error
   */
  checkFileAccess(filePath: string, operation: FileOperation): void {
    const fsConfig = this.config.filesystem;
    if (!fsConfig) {
      return; // 没有文件系统限制，直接通过
    }

    const resolvedPath = path.resolve(filePath);

    // 检查禁止的文件扩展名
    if (fsConfig.forbiddenExtensions && fsConfig.forbiddenExtensions.length > 0) {
      const ext = path.extname(resolvedPath).toLowerCase();
      if (ext && fsConfig.forbiddenExtensions.includes(ext)) {
        throw new Error(
          `文件扩展名 "${ext}" 不允许执行 "${operation}" 操作: ${filePath}`
        );
      }
    }

    // 检查读操作（read / exists / list）
    if (operation === "read" || operation === "exists" || operation === "list") {
      if (fsConfig.allowedReadDirs && fsConfig.allowedReadDirs.length > 0) {
        const allowed = fsConfig.allowedReadDirs.some((dir) => {
          const resolvedDir = path.resolve(dir);
          return resolvedPath.startsWith(resolvedDir) || resolvedPath === resolvedDir;
        });
        if (!allowed) {
          throw new Error(
            `路径不在允许的读取目录中: ${filePath}（允许: ${fsConfig.allowedReadDirs.join(", ")}）`
          );
        }
      }
    }

    // 检查写操作（write / delete）
    if (operation === "write" || operation === "delete") {
      if (fsConfig.allowedWriteDirs && fsConfig.allowedWriteDirs.length > 0) {
        const allowed = fsConfig.allowedWriteDirs.some((dir) => {
          const resolvedDir = path.resolve(dir);
          return resolvedPath.startsWith(resolvedDir) || resolvedPath === resolvedDir;
        });
        if (!allowed) {
          throw new Error(
            `路径不在允许的写入目录中: ${filePath}（允许: ${fsConfig.allowedWriteDirs.join(", ")}）`
          );
        }
      }
    }
  }
}

// ============================================================
// LocalWorkspace 类
// ============================================================

/**
 * 本地文件系统实现的工作空间
 * 直接在宿主机上执行命令和文件操作
 */
export class LocalWorkspace extends WorkspaceBase {
  public readonly type: WorkspaceType = "local";

  constructor(config: WorkspaceConfig) {
    super(config);
  }

  /**
   * 初始化本地沙盒
   * 直接设置为运行状态，无需额外操作
   */
  async initialize(): Promise<void> {
    this.status = "running";
  }

  /**
   * 关闭本地沙盒
   * 本地模式无需清理资源
   */
  async close(): Promise<void> {
    this.status = "stopped";
  }

  /**
   * 解析为基于工作目录的绝对路径
   */
  private resolvePath(filePath: string): string {
    return path.resolve(this.config.workDir, filePath);
  }

  /**
   * 在本地执行命令
   * @param command 要执行的命令
   * @param timeout 超时时间（毫秒）
   */
  async execCommand(command: string, timeout?: number): Promise<CommandResult> {
    const startTime = Date.now();

    try {
      const options: Record<string, unknown> = {
        shell: true,
        cwd: this.config.workDir,
      };

      if (timeout !== undefined && timeout > 0) {
        options.timeout = timeout;
      }

      const { stdout, stderr } = await execFileAsync(command, [], options);

      return {
        exitCode: 0,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        durationMs: Date.now() - startTime,
        timedOut: false,
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };

      return {
        exitCode: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? 0 : (err.code as unknown as number ?? 1),
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? err.message ?? String(error),
        durationMs: Date.now() - startTime,
        timedOut: err.killed === true || err.signal === "SIGTERM",
      };
    }
  }

  /**
   * 读取文件
   * @param filePath 文件路径（相对于 workDir 或绝对路径）
   */
  async readFile(filePath: string): Promise<FileResult> {
    const resolvedPath = this.resolvePath(filePath);
    this.checkFileAccess(resolvedPath, "read");

    try {
      const content = await fs.readFile(resolvedPath, "utf-8");
      return {
        operation: "read",
        path: filePath,
        content,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "read",
        path: filePath,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 写入文件
   * @param filePath 文件路径（相对于 workDir 或绝对路径）
   * @param content 文件内容
   */
  async writeFile(filePath: string, content: string): Promise<FileResult> {
    const resolvedPath = this.resolvePath(filePath);
    this.checkFileAccess(resolvedPath, "write");

    try {
      // 确保父目录存在
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, "utf-8");
      return {
        operation: "write",
        path: filePath,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "write",
        path: filePath,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 删除文件
   * @param filePath 文件路径（相对于 workDir 或绝对路径）
   */
  async deleteFile(filePath: string): Promise<FileResult> {
    const resolvedPath = this.resolvePath(filePath);
    this.checkFileAccess(resolvedPath, "delete");

    try {
      await fs.unlink(resolvedPath);
      return {
        operation: "delete",
        path: filePath,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "delete",
        path: filePath,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 列出目录内容
   * @param dir 目录路径（相对于 workDir 或绝对路径）
   */
  async listFiles(dir: string): Promise<FileResult> {
    const resolvedPath = this.resolvePath(dir);
    this.checkFileAccess(resolvedPath, "list");

    try {
      const files = await fs.readdir(resolvedPath);
      return {
        operation: "list",
        path: dir,
        files,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "list",
        path: dir,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 检查文件是否存在
   * @param filePath 文件路径（相对于 workDir 或绝对路径）
   */
  async exists(filePath: string): Promise<FileResult> {
    const resolvedPath = this.resolvePath(filePath);
    this.checkFileAccess(resolvedPath, "exists");

    try {
      await fs.access(resolvedPath);
      return {
        operation: "exists",
        path: filePath,
        success: true,
      };
    } catch {
      return {
        operation: "exists",
        path: filePath,
        success: false,
      };
    }
  }
}

// ============================================================
// DockerWorkspace 类
// ============================================================

/**
 * Docker 容器实现的工作空间
 * 在 Docker 容器中执行命令和文件操作
 */
export class DockerWorkspace extends WorkspaceBase {
  public readonly type: WorkspaceType = "docker";
  /** Docker 容器名称 */
  private containerName: string;

  constructor(config: WorkspaceConfig) {
    super(config);
    this.containerName = config.docker?.containerName ?? `workspace-${Date.now()}`;
  }

  /**
   * 对命令进行 shell 转义，用于安全的 docker exec 调用
   * 将单引号替换为 '\'' 序列，然后将整个命令用单引号包裹
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * 执行 Docker 命令并返回结果
   * @param args docker 命令参数列表
   * @param timeout 超时时间（毫秒）
   */
  private async execDockerCommand(
    args: string[],
    timeout?: number
  ): Promise<{ stdout: string; stderr: string }> {
    const options: Record<string, unknown> = {};

    if (timeout !== undefined && timeout > 0) {
      options.timeout = timeout;
    }

    try {
      const { stdout, stderr } = await execFileAsync("docker", args, options);
      return {
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      throw new Error(
        err.stderr?.toString() ?? err.message ?? String(error)
      );
    }
  }

  /**
   * 初始化 Docker 容器
   * 检查 Docker 是否可用，创建并运行容器
   */
  async initialize(): Promise<void> {
    try {
      // 检查 Docker 是否可用
      await this.execDockerCommand(["info"]);

      // 构建 docker run 参数
      const args: string[] = ["run", "-d", "--name", this.containerName];

      // 添加挂载卷
      const volumes = this.config.docker?.volumes ?? [];
      for (const vol of volumes) {
        args.push("-v", vol);
      }

      // 添加网络模式
      const networkMode = this.config.docker?.networkMode;
      if (networkMode) {
        args.push("--network", networkMode);
      }

      // 添加环境变量
      const env = this.config.docker?.env ?? {};
      for (const [key, value] of Object.entries(env)) {
        args.push("-e", `${key}=${value}`);
      }

      // 设置镜像和保持容器运行
      const image = this.config.docker?.image ?? "ubuntu:latest";
      args.push(image, "sleep", "infinity");

      await this.execDockerCommand(args);
      this.status = "running";
    } catch (error: unknown) {
      this.status = "error";
      throw new Error(
        `Docker 容器初始化失败: ${(error as Error).message}`
      );
    }
  }

  /**
   * 关闭 Docker 容器
   * 强制停止并删除容器
   */
  async close(): Promise<void> {
    try {
      await this.execDockerCommand(["rm", "-f", this.containerName]);
    } finally {
      this.status = "stopped";
    }
  }

  /**
   * 在 Docker 容器中执行命令
   * @param command 要执行的命令
   * @param timeout 超时时间（毫秒）
   */
  async execCommand(command: string, timeout?: number): Promise<CommandResult> {
    const startTime = Date.now();

    try {
      const escapedCmd = this.escapeShellArg(command);
      const args = ["exec", this.containerName, "/bin/sh", "-c", escapedCmd];

      const options: Record<string, unknown> = {};
      if (timeout !== undefined && timeout > 0) {
        options.timeout = timeout;
      }

      const { stdout, stderr } = await execFileAsync("docker", args, options);

      return {
        exitCode: 0,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        durationMs: Date.now() - startTime,
        timedOut: false,
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };

      // 尝试从错误中提取退出码
      let exitCode = 1;
      const stderrText = err.stderr?.toString() ?? "";
      const exitCodeMatch = stderrText.match(/exit code (\d+)/);
      if (exitCodeMatch) {
        exitCode = parseInt(exitCodeMatch[1], 10);
      }

      return {
        exitCode,
        stdout: err.stdout?.toString() ?? "",
        stderr: stderrText || err.message || String(error),
        durationMs: Date.now() - startTime,
        timedOut: err.killed === true || err.signal === "SIGTERM",
      };
    }
  }

  /**
   * 从 Docker 容器中读取文件
   * 使用 docker cp 导出 tar 并解析文件内容
   * @param filePath 容器内文件路径
   */
  async readFile(filePath: string): Promise<FileResult> {
    try {
      const args = ["cp", `${this.containerName}:${filePath}`, "-"];
      const options: Record<string, unknown> = { encoding: null as unknown as string };

      const { stdout } = await execFileAsync("docker", args, options);
      const stdoutBuffer = stdout as unknown as Buffer;

      // 解析 tar 格式输出
      const content = this.extractTarContent(stdoutBuffer, path.basename(filePath));

      return {
        operation: "read",
        path: filePath,
        content,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "read",
        path: filePath,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 从 tar buffer 中提取文件内容
   * tar 格式：每个文件由 512 字节头部 + 文件数据（补齐到 512 字节边界）组成
   */
  private extractTarContent(buffer: Buffer, targetFileName: string): string {
    let offset = 0;

    while (offset + 512 <= buffer.length) {
      // 读取文件名字段（偏移 0，长度 100）
      const name = buffer.toString("ascii", offset, offset + 100).replace(/\0+$/, "").trim();
      // 读取文件大小字段（偏移 124，长度 12，八进制 ASCII）
      const sizeStr = buffer.toString("ascii", offset + 124, offset + 136).replace(/\0+$/, "").trim();
      // 读取类型标志（偏移 156）
      const typeFlag = buffer.toString("ascii", offset + 156, offset + 157);

      // 检查是否是文件结束标记（两个连续的 512 字节零块）
      if (name === "" && sizeStr === "") {
        break;
      }

      const size = sizeStr ? parseInt(sizeStr, 8) : 0;

      // 跳过头部
      offset += 512;

      // 如果文件名匹配且是普通文件（typeFlag='0' 或 ' '），提取内容
      if ((name === targetFileName || name.endsWith(`/${targetFileName}`)) &&
          (typeFlag === "0" || typeFlag === "" || typeFlag === " ")) {
        return buffer.toString("utf-8", offset, offset + size);
      }

      // 跳过文件数据（补齐到 512 字节边界）
      const paddedSize = Math.ceil(size / 512) * 512;
      offset += paddedSize;
    }

    throw new Error(`在 tar 归档中未找到文件: ${targetFileName}`);
  }

  /**
   * 向 Docker 容器写入文件
   * @param filePath 容器内文件路径
   * @param content 文件内容
   */
  async writeFile(filePath: string, content: string): Promise<FileResult> {
    try {
      const base64Content = Buffer.from(content, "utf-8").toString("base64");
      const safePath = this.escapeShellArg(filePath);
      const command = `printf '%s' '${base64Content}' | base64 -d > ${safePath}`;
      const args = ["exec", this.containerName, "/bin/sh", "-c", command];

      const options: Record<string, unknown> = {};

      await execFileAsync("docker", args, options);

      return {
        operation: "write",
        path: filePath,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "write",
        path: filePath,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 删除 Docker 容器中的文件
   * @param filePath 容器内文件路径
   */
  async deleteFile(filePath: string): Promise<FileResult> {
    try {
      const escapedPath = this.escapeShellArg(filePath);
      const args = ["exec", this.containerName, "/bin/sh", "-c", `rm ${escapedPath}`];

      await execFileAsync("docker", args);

      return {
        operation: "delete",
        path: filePath,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "delete",
        path: filePath,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 列出 Docker 容器中的目录
   * @param dir 容器内目录路径
   */
  async listFiles(dir: string): Promise<FileResult> {
    try {
      const escapedDir = this.escapeShellArg(dir);
      const args = ["exec", this.containerName, "/bin/sh", "-c", `ls -1a ${escapedDir}`];

      const { stdout } = await execFileAsync("docker", args);

      const files = stdout
        .toString()
        .split("\n")
        .filter((line) => line.trim() !== "" && line !== "." && line !== "..");

      return {
        operation: "list",
        path: dir,
        files,
        success: true,
      };
    } catch (error: unknown) {
      return {
        operation: "list",
        path: dir,
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 检查 Docker 容器中的文件是否存在
   * @param filePath 容器内文件路径
   */
  async exists(filePath: string): Promise<FileResult> {
    try {
      const escapedPath = this.escapeShellArg(filePath);
      const args = ["exec", this.containerName, "/bin/sh", "-c", `test -f ${escapedPath}`];

      await execFileAsync("docker", args);

      return {
        operation: "exists",
        path: filePath,
        success: true,
      };
    } catch {
      return {
        operation: "exists",
        path: filePath,
        success: false,
      };
    }
  }
}

// ============================================================
// createWorkspace 工厂函数
// ============================================================

/**
 * 创建工作空间实例的工厂函数
 * 根据配置类型创建对应的 Workspace 实现
 * @param config 工作空间配置
 * @returns 对应类型的 Workspace 实例
 */
export function createWorkspace(config: WorkspaceConfig): WorkspaceBase {
  const type = config.type ?? "local";

  switch (type) {
    case "docker":
      return new DockerWorkspace(config);
    case "local":
    default:
      return new LocalWorkspace(config);
  }
}
