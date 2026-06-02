/**
 * MCP (Model Context Protocol) 相关类型定义
 */

// ============================================================
// MCP 服务器配置
// ============================================================

/** MCP 服务器配置 */
export interface MCPServerConfig {
  /** 服务器名称（唯一标识） */
  name: string;
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
  /** 启动超时（毫秒） */
  timeout?: number;
  /** 是否启用该服务器 */
  enabled?: boolean;
}

/** MCP 服务器状态 */
export type MCPServerStatus = "disconnected" | "connecting" | "connected" | "error";

/** MCP 服务器能力 */
export interface MCPServerCapabilities {
  /** 是否支持工具调用 */
  tools?: boolean;
  /** 是否支持资源读取 */
  resources?: boolean;
  /** 是否支持提示模板 */
  prompts?: boolean;
}

/** MCP 工具定义（从服务器发现） */
export interface MCPToolInfo {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  inputSchema: Record<string, unknown>;
}

/** MCP 资源定义 */
export interface MCPResource {
  /** 资源 URI */
  uri: string;
  /** 资源名称 */
  name: string;
  /** 资源描述 */
  description?: string;
  /** MIME 类型 */
  mimeType?: string;
}

/** MCP 服务器信息 */
export interface MCPServerInfo {
  /** 服务器名称 */
  name: string;
  /** 服务器版本 */
  version: string;
  /** 服务器能力 */
  capabilities: MCPServerCapabilities;
}

/** MCP 请求 */
export interface MCPRequest {
  /** 请求 ID */
  id: number | string;
  /** 请求方法 */
  method: string;
  /** 请求参数 */
  params?: Record<string, unknown>;
}

/** MCP 响应 */
export interface MCPResponse {
  /** 对应请求 ID */
  id: number | string;
  /** 响应结果 */
  result?: unknown;
  /** 错误信息 */
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** MCP 通知（无请求 ID 的单向消息） */
export interface MCPNotification {
  /** 通知方法 */
  method: string;
  /** 通知参数 */
  params?: Record<string, unknown>;
}

/** JSON-RPC 消息 */
export type JSONRPCMessage =
  | ({ jsonrpc: "2.0"; id: number | string } & ({ result: unknown } | { error: { code: number; message: string; data?: unknown } }))
  | { jsonrpc: "2.0"; id: number | string; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> };

// ============================================================
// MCP 客户端事件
// ============================================================

/** MCP 客户端事件类型 */
export type MCPClientEventType =
  | "connected"
  | "disconnected"
  | "error"
  | "tools_changed"
  | "resources_changed"
  | "notification";

/** MCP 客户端事件 */
export interface MCPClientEvent {
  /** 事件类型 */
  type: MCPClientEventType;
  /** 服务器名称 */
  serverName: string;
  /** 事件数据 */
  data?: unknown;
  /** 时间戳 */
  timestamp: number;
}

/** MCP 客户端事件监听器 */
export type MCPClientEventListener = (event: MCPClientEvent) => void;
