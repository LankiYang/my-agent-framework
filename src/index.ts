/**
 * Agent Framework 主入口
 * 统一注册和管理 Agent、Tool、Model、Channel、Storage、Orchestrator、MCP、Workspace
 */

import type {
  AgentDef,
  AgentContext,
  AgentResult,
  ToolDef,
  ModelProvider,
  ChannelDef,
  StorageProvider,
  OrchestratorDef,
  FrameworkRunOptions,
  FrameworkEvent,
  FrameworkEventType,
  FrameworkEventListener,
  Message,
  WorkspaceConfig,
} from "./core/types.js";
import {
  createOrchestrator,
  BaseOrchestrator,
  type CreateOrchestratorOptions,
} from "./orchestrator/index.js";
import {
  createWorkspace,
  WorkspaceBase,
} from "./provider/workspace.js";
import { MCPManager, createMCPManager } from "./mcp/manager.js";
import type { MCPServerConfig } from "./mcp/types.js";
import { agentLoop } from "./runtime/agent-loop.js";
import type { AgentLoopTerminal } from "./runtime/agent-loop.js";
import { PermissionEngine, PermissionMode } from "./runtime/permission.js";

// ============ Framework 类 ============

/**
 * Framework 核心类
 * 负责组件注册、生命周期管理和推理执行
 */
export class Framework {
  private agents: Map<string, AgentDef> = new Map();
  private tools: Map<string, ToolDef> = new Map();
  private models: Map<string, ModelProvider> = new Map();
  private channels: Map<string, ChannelDef> = new Map();
  private storages: Map<string, StorageProvider> = new Map();
  private orchestrators: Map<string, BaseOrchestrator> = new Map();
  private workspaces: Map<string, WorkspaceBase> = new Map();
  private mcpManager: MCPManager | null = null;
  private listeners: Map<FrameworkEventType, Set<FrameworkEventListener>> = new Map();
  private running = false;

  /** 注册 Agent */
  useAgent(def: AgentDef): this {
    if (this.agents.has(def.id)) {
      throw new Error(`Agent "${def.id}" 已存在`);
    }
    this.agents.set(def.id, def);
    return this;
  }

  /** 注册 Tool */
  useTool(def: ToolDef): this {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool "${def.name}" 已存在`);
    }
    this.tools.set(def.name, def);
    return this;
  }

  /** 注册 Model Provider */
  useModel(provider: ModelProvider): this {
    if (this.models.has(provider.id)) {
      throw new Error(`Model Provider "${provider.id}" 已存在`);
    }
    this.models.set(provider.id, provider);
    return this;
  }

  /** 注册 Channel */
  useChannel(def: ChannelDef): this {
    if (this.channels.has(def.id)) {
      throw new Error(`Channel "${def.id}" 已存在`);
    }
    this.channels.set(def.id, def);
    return this;
  }

  /** 注册 Storage Provider */
  useStorage(provider: StorageProvider, name: string): this {
    if (this.storages.has(name)) {
      throw new Error(`Storage Provider "${name}" 已存在`);
    }
    this.storages.set(name, provider);
    return this;
  }

  /** 注册编排器 */
  useOrchestrator(def: OrchestratorDef, supervisor?: AgentDef): this {
    if (this.orchestrators.has(def.id)) {
      throw new Error(`Orchestrator "${def.id}" 已存在`);
    }
    const orchestrator = createOrchestrator({ def, supervisor });
    this.orchestrators.set(def.id, orchestrator);
    return this;
  }

  /** 注册工作空间（沙盒） */
  useWorkspace(name: string, config: WorkspaceConfig): this {
    if (this.workspaces.has(name)) {
      throw new Error(`Workspace "${name}" 已存在`);
    }
    const workspace = createWorkspace(config);
    this.workspaces.set(name, workspace);
    return this;
  }

  /** 注册 MCP 服务器配置列表 */
  useMCP(configs: MCPServerConfig[]): this {
    if (!this.mcpManager) {
      this.mcpManager = createMCPManager(configs);
    } else {
      this.mcpManager.useServer(configs);
    }
    return this;
  }

  /** 获取 MCP 管理器实例 */
  getMCPManager(): MCPManager | null {
    return this.mcpManager;
  }

  /** 注册事件监听器 */
  on(type: FrameworkEventType, listener: FrameworkEventListener): this {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
    return this;
  }

  /** 移除事件监听器 */
  off(type: FrameworkEventType, listener: FrameworkEventListener): this {
    this.listeners.get(type)?.delete(listener);
    return this;
  }

  /** 发射事件 */
  private emit(type: FrameworkEventType, data: Record<string, unknown>): void {
    const event: FrameworkEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  /** 启动框架 */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("框架已在运行中");
    }
    this.running = true;

    // 连接所有 MCP 服务器
    if (this.mcpManager) {
      try {
        await this.mcpManager.connectAll();
      } catch (error) {
        console.error("MCP 服务器连接失败:", error);
      }
    }

    // 初始化所有工作空间
    for (const [name, ws] of this.workspaces) {
      try {
        await ws.initialize();
      } catch (error) {
        console.error(`Workspace "${name}" 初始化失败:`, error);
      }
    }

    // 启动所有 Channel
    for (const [id, channel] of this.channels) {
      try {
        await channel.start();
      } catch (error) {
        console.error(`Channel "${id}" 启动失败:`, error);
      }
    }
  }

  /** 停止框架 */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    // 停止所有 Channel
    for (const [id, channel] of this.channels) {
      try {
        await channel.stop();
      } catch (error) {
        console.error(`Channel "${id}" 停止失败:`, error);
      }
    }

    // 断开所有 MCP 服务器
    if (this.mcpManager) {
      try {
        await this.mcpManager.disconnectAll();
      } catch (error) {
        console.error("MCP 服务器断开失败:", error);
      }
    }

    // 关闭所有工作空间
    for (const [name, ws] of this.workspaces) {
      try {
        await ws.close();
      } catch (error) {
        console.error(`Workspace "${name}" 关闭失败:`, error);
      }
    }

    this.running = false;
  }

  /**
   * 通过 agentLoop 执行单个 Agent 的完整推理循环
   * 解析模型提供者、收集工具、创建权限引擎，消费 AsyncGenerator 返回最终结果
   */
  private async executeAgentLoop(
    agent: AgentDef,
    input: string,
    options?: FrameworkRunOptions,
  ): Promise<AgentResult> {
    // 1. 解析模型提供者
    const model = this.models.get(agent.model);
    if (!model) {
      throw new Error(`Model Provider "${agent.model}" 未注册（Agent "${agent.name}" 需要）`);
    }

    // 2. 收集工具（Agent 工具 + 框架全局工具，去重）
    const tools = [...agent.tools];
    for (const tool of this.tools.values()) {
      if (!tools.find((t) => t.name === tool.name)) {
        tools.push(tool);
      }
    }

    // 3. 构建初始消息
    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: "user",
      type: "text",
      content: input,
      timestamp: Date.now(),
    };
    const initialMessages: Message[] = [
      userMessage,
    ];

    // 4. 创建权限引擎
    const permissionEngine = new PermissionEngine();

    // 5. 构建 AgentLoopOptions
    const loopOptions = {
      model,
      tools,
      systemPrompt: agent.systemPrompt,
      maxTurns: agent.maxTurns,
      abortSignal: options?.abortSignal,
      permissionEngine,
      permissionMode: PermissionMode.Default,
    };

    // 6. 消费 AsyncGenerator（手动 .next() 迭代以捕获 terminal value）
    const gen = agentLoop(initialMessages, loopOptions);
    let terminal: AgentLoopTerminal;

    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        terminal = value as AgentLoopTerminal;
        break;
      }
    }

    // 7. 从 terminal 消息中提取最后的 assistant 输出
    const lastAssistant = [...terminal!.messages]
      .reverse()
      .find((m: Message) => m.role === "assistant");
    const output = lastAssistant?.content ?? input;

    return {
      output,
      messages: terminal!.messages,
      metadata: {
        agentId: agent.id,
        agentName: agent.name,
        stopReason: terminal!.reason,
        turnCount: terminal!.turnCount,
      },
    };
  }

  /** 执行单次推理 */
  async run(input: string, options?: FrameworkRunOptions): Promise<AgentResult> {
    if (!this.running) {
      throw new Error("框架未启动，请先调用 start()");
    }

    // 如果指定了编排器，使用编排器执行
    if (options?.orchestrator) {
      const orchestrator = this.orchestrators.get(options.orchestrator);
      if (!orchestrator) {
        throw new Error(`编排器 "${options.orchestrator}" 未注册`);
      }

      // 注入 agentLoop 执行函数，让编排器内部调用 agentLoop
      orchestrator.setAgentExecutor(
        (agent, agentInput, _ctx) => this.executeAgentLoop(agent, agentInput, options),
      );

      const result = await orchestrator.run({
        input,
        context: options.context,
        abortSignal: options.abortSignal,
      });

      return {
        output: result.output,
        messages: [
          {
            id: `result-${Date.now()}`,
            role: "assistant",
            type: "text",
            content: result.output,
            timestamp: Date.now(),
          },
        ],
        metadata: result.metadata,
      };
    }

    // 默认：使用第一个注册的 Agent，通过 agentLoop 执行完整推理
    const firstAgent = this.agents.values().next().value;
    if (!firstAgent) {
      throw new Error("未注册任何 Agent");
    }

    this.emit("agent:start", { agentId: firstAgent.id, agentName: firstAgent.name, input });

    try {
      const result = await this.executeAgentLoop(firstAgent, input, options);
      this.emit("agent:end", { agentId: firstAgent.id, output: result.output });
      return result;
    } catch (error) {
      this.emit("agent:error", { agentId: firstAgent.id, error });
      throw error;
    }
  }

  /** 获取已注册的 Agent */
  getAgent(id: string): AgentDef | undefined {
    return this.agents.get(id);
  }

  /** 获取已注册的 Tool */
  getTool(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  /** 获取已注册的 Model Provider */
  getModel(id: string): ModelProvider | undefined {
    return this.models.get(id);
  }

  /** 获取已注册的 Storage */
  getStorage(name: string): StorageProvider | undefined {
    return this.storages.get(name);
  }

  /** 获取已注册的编排器 */
  getOrchestrator(id: string): BaseOrchestrator | undefined {
    return this.orchestrators.get(id);
  }

  /** 获取已注册的工作空间 */
  getWorkspace(name: string): WorkspaceBase | undefined {
    return this.workspaces.get(name);
  }

  /** 框架是否正在运行 */
  get isRunning(): boolean {
    return this.running;
  }
}

// ============ 便捷工厂函数 ============

/** 定义 Agent 的便捷工厂函数 */
export function defineAgent(def: AgentDef): AgentDef {
  return def;
}

/** 定义 Tool 的便捷工厂函数 */
export function defineTool(def: ToolDef): ToolDef {
  return def;
}

/** 定义 Channel 的便捷工厂函数 */
export function defineChannel(def: ChannelDef): ChannelDef {
  return def;
}

/** 定义 Orchestrator 的便捷工厂函数 */
export function defineOrchestrator(def: OrchestratorDef): OrchestratorDef {
  return def;
}

// ============ 重导出所有公共 API 和类型 ============

export type {
  Message,
  MessageRole,
  MessageType,
  AgentDef,
  AgentId,
  AgentContext,
  AgentResult,
  ToolDef,
  ToolInput,
  ToolOutput,
  ModelProvider,
  ModelCallOptions,
  ModelCallResult,
  ModelResponse,
  StreamEvent,
  ChannelDef,
  StorageProvider,
  OrchestratorDef,
  OrchestratorRunOptions,
  OrchestratorResult,
  RouteFunction,
  FrameworkRunOptions,
  FrameworkEvent,
  FrameworkEventType,
  FrameworkEventListener,
  SharedContext,
  Session,
  ToolCall,
  ToolCallResult,
  ToolExecutionContext,
  EventBus,
  HookFn,
} from "./core/types.js";

export {
  AgentState,
  OrchestratorStrategy,
  LifecycleHookPoint,
} from "./core/types.js";

export {
  HookPoint,
} from "./runtime/middleware.js";

export {
  HookRegistry,
} from "./runtime/middleware.js";

export {
  PermissionEngine,
  PermissionMode,
  PermissionLevel,
} from "./runtime/permission.js";

export {
  ToolExecutor,
  ToolExecutionError,
  ToolTimeoutError,
} from "./runtime/tool-executor.js";

export {
  Toolkit,
} from "./runtime/tool-group.js";

export type {
  AgentLoopOptions,
  AgentLoopDeps,
  StopReason,
  ContinueReason,
  AgentLoopEvent,
  AgentLoopTerminal,
} from "./runtime/agent-loop.js";

export {
  agentLoop,
} from "./runtime/agent-loop.js";

export {
  BaseOrchestrator,
  SequentialOrchestrator,
  ParallelOrchestrator,
  RouterOrchestrator,
  SupervisorOrchestrator,
  createOrchestrator,
} from "./orchestrator/index.js";

export {
  BaseModelProvider,
  EchoModelProvider,
} from "./provider/model/index.js";

export {
  BaseChannel,
} from "./provider/channel/index.js";
export { CLIChannel } from "./provider/channel/cli-channel.js";
export type { ChannelDef as ChannelDefExport } from "./provider/channel/index.js";
export type { CLIChannelOptions } from "./provider/channel/cli-channel.js";

export {
  MemoryStorage,
  FileStorage,
} from "./provider/storage/index.js";

export {
  WorkspaceBase,
  createWorkspace,
} from "./provider/workspace.js";
export type { WorkspaceConfig, WorkspaceType, WorkspaceStatus, CommandResult, FileResult } from "./core/types.js";

// ============ MCP 模块导出 ============

export {
  MCPManager,
  createMCPManager,
} from "./mcp/manager.js";

export {
  MCPClient,
} from "./mcp/client.js";

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
} from "./mcp/types.js";

// ============ Token 计数器模块导出 ============

export {
  TokenCounter,
  countTokens,
  isWithinTokenBudget,
  MODEL_PRESETS,
} from "./utils/token-counter.js";

export type {
  TokenizerType,
  TokenCountResult,
  TokenCountDetail,
  TokenCounterOptions,
} from "./utils/token-counter.js";

// ============ 高层抽象 API 导出 ============

export {
  createTool,
  createAgent,
  createApp,
  createChannel,
  createModel,
  createMiddleware,
  pipe,
  parallel,
  toolbox,
} from "./api.js";

export type {
  ToolConfig,
  AgentConfig,
  AppConfig,
  ListenConfig,
  OrchestrateConfig,
  App,
  SimpleMiddlewareContext,
  SimpleNextFn,
  SimpleMiddlewareHandler,
  CLIChannelConfig,
  HTTPChannelConfig,
  CustomChannelConfig,
  ClaudeModelConfig,
  OpenAIModelConfig,
  CustomModelConfig,
  Pipeline,
  ToolboxItemConfig,
  ToolboxResult,
} from "./api.js";
