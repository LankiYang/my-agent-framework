/**
 * MCP (Model Context Protocol) 模块
 * 提供 MCP 客户端、服务器管理和类型定义
 */

export { MCPManager, createMCPManager } from "./manager.js";
export { MCPClient } from "./client.js";
export type {
  MCPServerConfig,
  MCPServerStatus,
  MCPServerCapabilities,
  MCPToolInfo,
  MCPResource,
  MCPServerInfo,
  MCPRequest,
  MCPResponse,
  MCPNotification,
  JSONRPCMessage,
  MCPClientEventType,
  MCPClientEvent,
  MCPClientEventListener,
} from "./types.js";
