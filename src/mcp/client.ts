/**
 * MCP Client
 * 管理与单个 MCP 服务器的 JSON-RPC 通信
 */

import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import type {
  MCPServerConfig,
  MCPServerStatus,
  MCPServerInfo,
  MCPServerCapabilities,
  MCPToolInfo,
  MCPResource,
  MCPRequest,
  MCPResponse,
  MCPNotification,
  JSONRPCMessage,
  MCPClientEventType,
  MCPClientEventListener,
  MCPClientEvent,
} from "./types.js";

/** 线协议分隔符 */
const LINE_SEPARATOR = "\n";
/** 消息缓冲区最大大小 */
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB

/**
 * MCPClient
 * 管理与单个 MCP 服务器的连接和 JSON-RPC 通信
 */
export class MCPClient {
  /** 服务器配置 */
  readonly config: MCPServerConfig;
  /** 连接状态 */
  status: MCPServerStatus = "disconnected";

  /** 子进程引用 */
  private process: ChildProcess | null = null;
  /** readline 接口 */
  private rl: Interface | null = null;
  /** 请求 ID 计数器 */
  private requestIdCounter = 0;
  /** 待处理请求映射 */
  private pendingRequests: Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  /** 事件监听器 */
  private listeners: Map<MCPClientEventType, Set<MCPClientEventListener>> = new Map();

  /** 已发现的工具 */
  private _tools: MCPToolInfo[] = [];
  /** 已发现的资源 */
  private _resources: MCPResource[] = [];
  /** 服务器信息 */
  private _serverInfo: MCPServerInfo | null = null;

  constructor(config: MCPServerConfig) {
    this.config = { timeout: 10000, ...config };
  }

  /** 获取已发现的工具 */
  get tools(): MCPToolInfo[] {
    return [...this._tools];
  }

  /** 获取已发现的资源 */
  get resources(): MCPResource[] {
    return [...this._resources];
  }

  /** 获取服务器信息 */
  get serverInfo(): MCPServerInfo | null {
    return this._serverInfo;
  }

  /** 生成下一个请求 ID */
  private nextRequestId(): number {
    return ++this.requestIdCounter;
  }

  /** 注册事件监听器 */
  on(type: MCPClientEventType, listener: MCPClientEventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  /** 移除事件监听器 */
  off(type: MCPClientEventType, listener: MCPClientEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** 发射事件 */
  private emit(type: MCPClientEventType, data?: unknown): void {
    const event: MCPClientEvent = {
      type,
      serverName: this.config.name,
      data,
      timestamp: Date.now(),
    };
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  /**
   * 连接到 MCP 服务器
   * 启动子进程并初始化 JSON-RPC 连接
   */
  async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") {
      return;
    }

    this.status = "connecting";

    try {
      const [command, ...args] = this.config.args
        ? [this.config.command, ...this.config.args]
        : [this.config.command];

      this.process = spawn(command, args, {
        env: { ...process.env, ...this.config.env },
        cwd: this.config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      // 处理进程错误
      this.process.on("error", (err: Error) => {
        this.status = "error";
        this.emit("error", { message: err.message });
        this.cleanup();
      });

      this.process.on("exit", (code: number | null) => {
        this.status = "disconnected";
        this.emit("disconnected", { exitCode: code });
        this.cleanup();
      });

      // 设置 stdout 读取
      if (this.process.stdout) {
        this.rl = createInterface({
          input: this.process.stdout,
          crlfDelay: Infinity,
        });

        let buffer = "";
        this.rl.on("line", (line: string) => {
          buffer += line;
          try {
            const message = JSON.parse(buffer) as JSONRPCMessage;
            buffer = "";
            this.handleMessage(message);
          } catch {
            // 可能是不完整的 JSON，继续累积
            if (buffer.length > MAX_BUFFER_SIZE) {
              console.error(`[MCP:${this.config.name}] 消息缓冲区溢出`);
              buffer = "";
            }
          }
        });
      }

      // 处理 stderr（日志输出）
      if (this.process.stderr) {
        this.process.stderr.on("data", (data: Buffer) => {
          const message = data.toString().trim();
          if (message) {
            this.emit("notification", { level: "stderr", message });
          }
        });
      }

      this.status = "connected";
      this.emit("connected", {});

      // 连接后自动发现工具和资源
      await this.discover();
    } catch (error) {
      this.status = "error";
      this.emit("error", { message: (error as Error).message });
      throw error;
    }
  }

  /**
   * 断开与 MCP 服务器的连接
   */
  async disconnect(): Promise<void> {
    // 拒绝所有待处理请求
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP 服务器 "${this.config.name}" 已断开连接`));
    }
    this.pendingRequests.clear();

    this.cleanup();
    this.status = "disconnected";
  }

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextRequestId();
      const message: JSONRPCMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP 请求超时: ${method} (${this.config.name})`));
      }, this.config.timeout ?? 10000);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendRaw(JSON.stringify(message));
    });
  }

  /**
   * 发送 JSON-RPC 通知（无响应期望）
   */
  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.sendRaw(JSON.stringify(message));
  }

  /** 发送原始消息到子进程 stdin */
  private sendRaw(data: string): void {
    if (!this.process?.stdin?.writable) {
      throw new Error(`MCP 服务器 "${this.config.name}" 未连接`);
    }
    this.process.stdin.write(data + LINE_SEPARATOR);
  }

  /** 处理收到的 JSON-RPC 消息 */
  private handleMessage(message: JSONRPCMessage): void {
    // 响应消息
    if ("id" in message && !("method" in message)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);

        if ("error" in message) {
          pending.reject(new Error(
            `MCP 错误 [${message.error.code}]: ${message.error.message}`
          ));
        } else {
          pending.resolve("result" in message ? message.result : undefined);
        }
      }
      return;
    }

    // 通知消息（无 id，有 method）
    if ("method" in message && !("id" in message)) {
      this.handleNotification(message.method, (message as { params?: Record<string, unknown> }).params);
      return;
    }

    // 带 id 的请求（服务器发起的请求）
    if ("method" in message && "id" in message) {
      // 目前暂不处理服务器发起的请求
      console.warn(`[MCP:${this.config.name}] 收到未处理的服务器请求: ${message.method}`);
    }
  }

  /** 处理通知消息 */
  private handleNotification(method: string, params?: Record<string, unknown>): void {
    switch (method) {
      case "notifications/tools/list_changed":
        // 工具列表已变更，重新发现
        this.discoverTools().catch(console.error);
        break;
      case "notifications/resources/list_changed":
        // 资源列表已变更，重新发现
        this.discoverResources().catch(console.error);
        break;
      default:
        this.emit("notification", { method, params });
    }
  }

  /** 清理资源 */
  private cleanup(): void {
    this.rl?.close();
    this.rl = null;

    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // 进程可能已经退出
      }
      this.process = null;
    }
  }

  // ============================================================
  // 服务发现
  // ============================================================

  /**
   * 发现服务器的工具、资源和能力
   */
  async discover(): Promise<void> {
    try {
      const [serverInfo, tools, resources] = await Promise.all([
        this.discoverServerInfo(),
        this.discoverTools(),
        this.discoverResources(),
      ]);

      this._serverInfo = serverInfo;
      this._tools = tools;
      this._resources = resources;
    } catch (error) {
      console.error(`[MCP:${this.config.name}] 服务发现失败:`, (error as Error).message);
    }
  }

  /** 发现服务器信息 */
  private async discoverServerInfo(): Promise<MCPServerInfo> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      clientInfo: {
        name: "agent-framework",
        version: "0.1.0",
      },
    });

    const data = result as {
      protocolVersion?: string;
      serverInfo?: { name: string; version: string };
      capabilities?: MCPServerCapabilities;
    };

    // 发送 initialized 通知
    this.sendNotification("notifications/initialized");

    return {
      name: data.serverInfo?.name ?? this.config.name,
      version: data.serverInfo?.version ?? "unknown",
      capabilities: data.capabilities ?? {},
    };
  }

  /** 发现工具列表 */
  private async discoverTools(): Promise<MCPToolInfo[]> {
    try {
      const result = await this.sendRequest("tools/list");
      const data = result as { tools?: MCPToolInfo[] };
      const tools = data.tools ?? [];
      this.emit("tools_changed", { tools });
      return tools;
    } catch {
      return [];
    }
  }

  /** 发现资源列表 */
  private async discoverResources(): Promise<MCPResource[]> {
    try {
      const result = await this.sendRequest("resources/list");
      const data = result as { resources?: MCPResource[] };
      const resources = data.resources ?? [];
      this.emit("resources_changed", { resources });
      return resources;
    } catch {
      return [];
    }
  }

  // ============================================================
  // 工具调用
  // ============================================================

  /**
   * 调用 MCP 服务器上的工具
   * @param toolName 工具名称
   * @param args 工具参数
   * @returns 工具调用结果
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.sendRequest("tools/call", {
      name: toolName,
      arguments: args,
    });

    return result;
  }

  /**
   * 获取工具列表
   */
  async listTools(): Promise<MCPToolInfo[]> {
    this._tools = await this.discoverTools();
    return this._tools;
  }

  // ============================================================
  // 资源访问
  // ============================================================

  /**
   * 读取 MCP 资源
   * @param uri 资源 URI
   */
  async readResource(uri: string): Promise<unknown> {
    const result = await this.sendRequest("resources/read", { uri });
    return result;
  }

  /**
   * 获取资源列表
   */
  async listResources(): Promise<MCPResource[]> {
    this._resources = await this.discoverResources();
    return this._resources;
  }
}
