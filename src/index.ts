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
import type { AgentLoopTerminal, AgentLoopEvent } from "./runtime/agent-loop.js";
import { PermissionEngine, PermissionMode } from "./runtime/permission.js";
import { HookRegistry, HookPoint } from "./runtime/middleware.js";
import type { MiddlewareFn } from "./runtime/middleware.js";
import { SessionManager } from "./runtime/session-manager.js";

/** 把 AgentDef.permissionMode 字符串解析为 PermissionMode 枚举，无效值回退 Default */
function resolvePermissionMode(mode: string | undefined): PermissionMode {
  if (!mode) return PermissionMode.Default;
  const values = Object.values(PermissionMode) as string[];
  return values.includes(mode) ? (mode as PermissionMode) : PermissionMode.Default;
}

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
  /** 默认执行环境，注入内置工具的 SharedContext.env */
  private defaultEnv: unknown;
  /** 会话管理器：per-session 隔离的消息历史，支撑多用户/多会话 */
  private sessionManager: SessionManager = new SessionManager();
  /** 共享权限引擎：用户在此配置身份感知规则（denyToolForUser 等），跨 run 生效 */
  private permissionEngine: PermissionEngine = new PermissionEngine();

  /** 访问权限引擎，配置身份感知的工具权限规则 */
  get permissions(): PermissionEngine {
    return this.permissionEngine;
  }

  /** 设置默认执行环境（ExecutionEnv），内置 read/write/bash 工具会用它访问系统 */
  useEnv(env: unknown): this {
    this.defaultEnv = env;
    return this;
  }

  /** 为会话历史启用持久化后端（跨进程恢复）。传入一个 StorageProvider */
  useSessionStorage(provider: StorageProvider): this {
    this.sessionManager = new SessionManager({ storage: provider });
    return this;
  }

  /** 访问会话管理器（列出/删除/查询会话） */
  get sessions(): SessionManager {
    return this.sessionManager;
  }

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

  /**
   * 启动框架。
   * - MCP 连接失败视为 optional：仅警告并通过 emit 通知，继续启动。
   * - Workspace / Channel 初始化失败视为 critical：回滚 running 并抛错，
   *   避免"标记为运行中但关键组件不可用"的隐蔽故障。
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("框架已在运行中");
    }
    this.running = true;

    // 连接所有 MCP 服务器（optional：失败不阻断）
    if (this.mcpManager) {
      try {
        await this.mcpManager.connectAll();
      } catch (error) {
        console.warn("[Framework] MCP 服务器连接失败（已跳过，其余功能不受影响）:", error);
        this.emit("agent:error", { phase: "start", component: "mcp", error });
      }
    }

    // 初始化所有工作空间（critical）
    for (const [name, ws] of this.workspaces) {
      try {
        await ws.initialize();
      } catch (error) {
        this.running = false;
        throw new Error(
          `Workspace "${name}" 初始化失败，框架启动中止: ${(error as Error).message}`,
        );
      }
    }

    // 启动所有 Channel（critical）
    for (const [id, channel] of this.channels) {
      try {
        await channel.start();
      } catch (error) {
        this.running = false;
        throw new Error(
          `Channel "${id}" 启动失败，框架启动中止: ${(error as Error).message}`,
        );
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
   * 准备单个 Agent 的 agentLoop 输入：解析模型、收集工具、装配权限与中间件。
   * 供一次性执行与流式执行共用。
   */
  private prepareAgentLoop(
    agent: AgentDef,
    input: string,
    options?: FrameworkRunOptions,
    historyMessages: Message[] = [],
  ): { initialMessages: Message[]; loopOptions: Parameters<typeof agentLoop>[1] } {
    // 1. 解析模型提供者
    // 1. 解析模型提供者：优先 agent 自带的 modelProvider 实例，否则按 id 查注册表
    let model = agent.modelProvider ?? this.models.get(agent.model);
    if (agent.modelProvider && !this.models.has(agent.modelProvider.id)) {
      // agent 携带了 provider 实例但未注册，自动补注册，保证一致性
      this.models.set(agent.modelProvider.id, agent.modelProvider);
    }
    if (!model) {
      const registered = [...this.models.keys()];
      throw new Error(
        `Model Provider "${agent.model}" 未注册（Agent "${agent.name}" 需要）。\n` +
          `已注册的 Model: [${registered.join(", ") || "无"}]。\n` +
          `修复：framework.useModel(provider)，或在 createApp({ model }) / createAgent({ model: providerInstance }) 传入。`,
      );
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
    // 会话历史（若有）作为前缀，实现多轮对话
    const initialMessages: Message[] = [
      ...historyMessages,
      userMessage,
    ];

    // 4. 权限引擎：使用框架共享实例，使用户配置的身份感知规则跨 run 生效
    const permissionEngine = this.permissionEngine;

    // 4b. 解析 Agent 的权限模式（字符串 → 枚举，无效值回退 Default）
    const permissionMode = resolvePermissionMode(agent.permissionMode);

    // 4c. 装配 Agent 中间件到 HookRegistry（按 hookPoint 注册，缺省 onReply）
    let hooks: HookRegistry | undefined;
    if (agent.middleware && agent.middleware.length > 0) {
      hooks = new HookRegistry();
      const validPoints = new Set(Object.values(HookPoint) as string[]);
      for (const mw of agent.middleware) {
        const point =
          mw.hookPoint && validPoints.has(mw.hookPoint)
            ? (mw.hookPoint as HookPoint)
            : HookPoint.onReply;
        hooks.register(point, mw.fn as MiddlewareFn);
      }
    }

    // 5. 构建 AgentLoopOptions
    const loopOptions = {
      model,
      tools,
      systemPrompt: agent.systemPrompt,
      maxTurns: agent.maxTurns,
      abortSignal: options?.abortSignal,
      permissionEngine,
      permissionMode,
      askHandler: options?.askHandler,
      hooks,
      compaction: agent.contextBudget ? { budget: agent.contextBudget } : undefined,
      env: this.defaultEnv,
      identity: options?.userId ? { userId: options.userId, role: options?.role } : undefined,
    };

    return { initialMessages, loopOptions };
  }

  /**
   * 流式执行单个 Agent：把 agentLoop 的事件逐个 yield 给调用方，
   * 返回 AgentLoopTerminal 作为 generator 的 return 值。
   * 这是对外流式 API（runStream / chatStream）的底层。
   */
  private async *streamAgentLoop(
    agent: AgentDef,
    input: string,
    options?: FrameworkRunOptions,
  ): AsyncGenerator<AgentLoopEvent, AgentLoopTerminal> {
    // 有 sessionId 时载入该会话历史作为上下文前缀（多轮/多用户隔离）
    const sessionId = options?.sessionId;
    const history = sessionId ? await this.sessionManager.getMessages(sessionId) : [];

    const { initialMessages, loopOptions } = this.prepareAgentLoop(agent, input, options, history);
    const gen = agentLoop(initialMessages, loopOptions);
    let next = await gen.next();
    while (!next.done) {
      yield next.value;
      next = await gen.next();
    }
    const terminal = next.value;

    // 回存：把本轮完整历史写回该会话，供下次续接
    if (sessionId) {
      await this.sessionManager.replaceMessages(sessionId, terminal.messages, options?.userId);
    }
    return terminal;
  }

  /**
   * 通过 agentLoop 执行单个 Agent 的完整推理循环（一次性，返回最终结果）。
   */
  private async executeAgentLoop(
    agent: AgentDef,
    input: string,
    options?: FrameworkRunOptions,
  ): Promise<AgentResult> {
    // 复用流式底层，消费到终止
    const gen = this.streamAgentLoop(agent, input, options);
    let next = await gen.next();
    while (!next.done) {
      next = await gen.next();
    }
    const terminal = next.value;

    // 从 terminal 消息中提取最后的 assistant 输出
    const lastAssistant = [...terminal.messages]
      .reverse()
      .find((m: Message) => m.role === "assistant");
    const output = lastAssistant?.content ?? input;

    return {
      output,
      messages: terminal.messages,
      metadata: {
        agentId: agent.id,
        agentName: agent.name,
        stopReason: terminal.reason,
        turnCount: terminal.turnCount,
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

      // per-run 传入 agentLoop 执行器（并发安全，不再覆盖实例字段）
      const result = await orchestrator.run({
        input,
        context: options.context,
        abortSignal: options.abortSignal,
        executor: (agent, agentInput, _ctx) => this.executeAgentLoop(agent, agentInput, options),
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

    // 默认：使用指定的 Agent（options.agent，按 id 或 name），否则第一个注册的 Agent
    const targetAgent = this.selectAgent(options?.agent);

    this.emit("agent:start", { agentId: targetAgent.id, agentName: targetAgent.name, input });

    try {
      const result = await this.executeAgentLoop(targetAgent, input, options);
      this.emit("agent:end", { agentId: targetAgent.id, output: result.output });
      return result;
    } catch (error) {
      this.emit("agent:error", { agentId: targetAgent.id, error });
      throw error;
    }
  }

  /** 选择目标 Agent：给定 id/name 则解析，否则取第一个注册的；找不到抛富错误 */
  private selectAgent(agentKey?: string): AgentDef {
    if (agentKey) {
      const found = this.resolveAgent(agentKey);
      if (!found) {
        throw new Error(
          `未找到 Agent "${agentKey}"。已注册: [${this.listAgentLabels()}]。（agent 参数接受 id 或 name）`,
        );
      }
      return found;
    }
    const first = this.agents.values().next().value;
    if (!first) {
      throw new Error("未注册任何 Agent，请先 framework.useAgent(agent) 或 createApp({ agents })");
    }
    return first;
  }

  /**
   * 流式执行单次推理：yield agentLoop 的每个事件（内容增量、工具执行、恢复等），
   * generator 结束时 return 最终 AgentLoopTerminal。
   * 不支持 orchestrator（编排走 run）；用于需要实时进度的单 Agent 场景。
   *
   * @example
   * for await (const ev of framework.runStream("你好")) {
   *   if (ev.type === "content_delta") process.stdout.write(ev.delta);
   * }
   */
  async *runStream(
    input: string,
    options?: FrameworkRunOptions,
  ): AsyncGenerator<AgentLoopEvent, AgentLoopTerminal> {
    if (!this.running) {
      throw new Error("框架未启动，请先调用 start()");
    }
    const targetAgent = this.selectAgent(options?.agent);
    this.emit("agent:start", { agentId: targetAgent.id, agentName: targetAgent.name, input });
    try {
      const terminal = yield* this.streamAgentLoop(targetAgent, input, options);
      this.emit("agent:end", { agentId: targetAgent.id, output: "" });
      return terminal;
    } catch (error) {
      this.emit("agent:error", { agentId: targetAgent.id, error });
      throw error;
    }
  }

  /** 获取已注册的 Agent */
  getAgent(id: string): AgentDef | undefined {
    return this.agents.get(id);
  }

  /** 按 id 或 name 解析 Agent（id 优先），供 run/orchestrate 复用 */
  resolveAgent(idOrName: string): AgentDef | undefined {
    const byId = this.agents.get(idOrName);
    if (byId) return byId;
    for (const a of this.agents.values()) {
      if (a.name === idOrName) return a;
    }
    return undefined;
  }

  /** 列出已注册 Agent 的 "name(id)" 标签，用于错误提示 */
  private listAgentLabels(): string {
    return [...this.agents.values()].map((a) => `${a.name}(${a.id})`).join(", ") || "无";
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
export type {
  PermissionContext,
  PermissionRule,
  RequesterIdentity,
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
  compactMessages,
  shouldCompact,
} from "./runtime/compaction.js";
export type {
  CompactionOptions,
  CompactionResult,
} from "./runtime/compaction.js";

export {
  loadSkills,
  parseSkillMarkdown,
  formatSkillsForPrompt,
} from "./runtime/skills.js";
export type { Skill } from "./runtime/skills.js";

export { SessionManager } from "./runtime/session-manager.js";
export type { SessionManagerOptions } from "./runtime/session-manager.js";

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
export { ClaudeModelProvider } from "./provider/model/claude.js";
export { OpenAIModelProvider } from "./provider/model/openai.js";
export type { ClaudeProviderConfig } from "./provider/model/claude.js";
export type { OpenAIProviderConfig } from "./provider/model/openai.js";

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
export { NodeExecutionEnv } from "./provider/env.js";
export type { ExecutionEnv, ExecResult } from "./provider/env.js";
export {
  createReadTool,
  createWriteTool,
  createBashTool,
  createBuiltinTools,
} from "./provider/builtin-tools.js";
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
  agentAsTool,
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
  AgentAsToolConfig,
} from "./api.js";
