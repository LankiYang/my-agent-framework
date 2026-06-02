/**
 * MCP Manager
 * 管理多个 MCP 客户端的生命周期和工具聚合
 */

import type { ToolDef } from "../core/types.js";
import { MCPClient } from "./client.js";
import type {
  MCPServerConfig,
  MCPToolInfo,
  MCPResource,
  MCPClientEventType,
  MCPClientEventListener,
  MCPClientEvent,
} from "./types.js";

/**
 * MCPManager
 * 管理 MCP 服务器连接池，提供统一的工具发现和调用接口
 */
export class MCPManager {
  /** 已注册的客户端映射表 */
  private clients: Map<string, MCPClient> = new Map();
  /** 事件监听器 */
  private listeners: Map<MCPClientEventType, Set<MCPClientEventListener>> = new Map();

  /**
   * 注册 MCP 服务器配置列表
   * @param configs MCP 服务器配置数组
   */
  useServer(configs: MCPServerConfig[]): void {
    for (const config of configs) {
      if (this.clients.has(config.name)) {
        console.warn(`[MCPManager] 服务器 "${config.name}" 已注册，将替换`);
        const existing = this.clients.get(config.name);
        existing?.disconnect().catch(() => {});
      }
      const client = new MCPClient(config);
      this.clients.set(config.name, client);
      // 转发客户端事件
      this.forwardClientEvents(client);
    }
  }

  /**
   * 启动所有 MCP 服务器连接
   */
  async connectAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [name, client] of this.clients) {
      const config = client.config;
      if (config.enabled === false) {
        console.log(`[MCPManager] 服务器 "${name}" 已禁用，跳过`);
        continue;
      }
      tasks.push(
        client.connect().catch((error) => {
          console.error(`[MCPManager] 服务器 "${name}" 连接失败:`, (error as Error).message);
        })
      );
    }
    await Promise.allSettled(tasks);
  }

  /**
   * 断开所有 MCP 服务器连接
   */
  async disconnectAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [name, client] of this.clients) {
      tasks.push(
        client.disconnect().catch((error) => {
          console.error(`[MCPManager] 服务器 "${name}" 断开失败:`, (error as Error).message);
        })
      );
    }
    await Promise.allSettled(tasks);
  }

  /**
   * 获取所有已发现的 MCP 工具（聚合所有服务器）
   * @returns 合并的工具列表，工具名称自动添加服务器前缀
   */
  getAllTools(): ToolDef[] {
    const tools: ToolDef[] = [];
    for (const [serverName, client] of this.clients) {
      if (client.status !== "connected") {
        continue;
      }
      for (const toolInfo of client.tools) {
        const prefixedName = `mcp__${serverName}__${toolInfo.name}`;
        tools.push({
          name: prefixedName,
          description: `[MCP:${serverName}] ${toolInfo.description}`,
          inputSchema: toolInfo.inputSchema,
          execute: async (input) => {
            try {
              const result = await client.callTool(toolInfo.name, input);
              return {
                content: typeof result === "string" ? result : JSON.stringify(result),
              };
            } catch (error) {
              return {
                content: `MCP 工具调用失败: ${(error as Error).message}`,
              };
            }
          },
          isConcurrencySafe: true,
          isReadOnly: false,
        });
      }
    }
    return tools;
  }

  /**
   * 获取所有已发现的 MCP 资源（聚合所有服务器）
   */
  getAllResources(): Array<MCPResource & { serverName: string }> {
    const resources: Array<MCPResource & { serverName: string }> = [];
    for (const [serverName, client] of this.clients) {
      if (client.status !== "connected") {
        continue;
      }
      for (const resource of client.resources) {
        resources.push({ ...resource, serverName });
      }
    }
    return resources;
  }

  /**
   * 获取指定 MCP 客户端
   * @param name 服务器名称
   */
  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  /**
   * 获取所有 MCP 客户端
   */
  getAllClients(): MCPClient[] {
    return [...this.clients.values()];
  }

  /**
   * 获取所有已连接的客户端名称
   */
  getConnectedClients(): string[] {
    return [...this.clients.entries()]
      .filter(([_, client]) => client.status === "connected")
      .map(([name]) => name);
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

  /** 转发客户端事件到管理器级监听器 */
  private forwardClientEvents(client: MCPClient): void {
    const eventTypes: MCPClientEventType[] = [
      "connected", "disconnected", "error",
      "tools_changed", "resources_changed", "notification",
    ];
    for (const type of eventTypes) {
      client.on(type, (event: MCPClientEvent) => {
        this.listeners.get(type)?.forEach((listener) => listener(event));
      });
    }
  }
}

/**
 * 创建 MCPManager 实例的工厂函数
 * @param configs 可选的初始 MCP 服务器配置列表
 */
export function createMCPManager(configs?: MCPServerConfig[]): MCPManager {
  const manager = new MCPManager();
  if (configs && configs.length > 0) {
    manager.useServer(configs);
  }
  return manager;
}
