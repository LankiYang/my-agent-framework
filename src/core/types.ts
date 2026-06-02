// ============================================================
// Message 相关类型
// ============================================================

/** 消息角色 */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/** 消息类型 */
export type MessageType = "text" | "tool_call" | "tool_result";

/** 基础消息结构 */
export interface Message {
  id: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** 工具调用消息 */
export interface ToolCallMessage extends Message {
  role: "assistant";
  type: "tool_call";
  toolName: string;
  toolInput: ToolInput;
  toolCallId: string;
}

/** 工具结果消息 */
export interface ToolResultMessage extends Message {
  role: "tool";
  type: "tool_result";
  toolCallId: string;
  toolOutput: ToolOutput;
  isError: boolean;
}

// ============================================================
// Tool 相关类型
// ============================================================

/** 工具输入（任意 JSON 兼容数据） */
export type ToolInput = Record<string, unknown>;

/** 工具输出 */
export type ToolOutput = {
  content: string;
  artifacts?: Record<string, unknown>[];
};

/** 工具定义接口 */
export interface ToolDef {
  /** 工具唯一名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** JSON Schema 格式的输入参数定义 */
  inputSchema: Record<string, unknown>;
  /** 执行工具逻辑 */
  execute(input: ToolInput, context: SharedContext): Promise<ToolOutput>;
  /** 判断工具在当前上下文是否可用 */
  isEnabled?(context: SharedContext): boolean;
  /** 是否支持并发安全调用 */
  isConcurrencySafe?: boolean;
  /** 是否为只读操作（不产生副作用） */
  isReadOnly?: boolean;
  /** 工具执行超时时间（毫秒） */
  timeout?: number;
  /** 校验输入参数 */
  validateInput?(input: ToolInput): { valid: boolean; error?: string };
  /** 检查调用权限 */
  checkPermissions?(context: SharedContext): Promise<boolean>;
}

// ============================================================
// Agent 相关类型
// ============================================================

/** Agent 唯一标识 */
export type AgentId = string;

/** Agent 运行状态 */
export enum AgentState {
  /** 空闲 */
  Idle = "idle",
  /** 运行中 */
  Running = "running",
  /** 等待工具结果 */
  WaitingForTool = "waiting_for_tool",
  /** 等待用户输入 */
  WaitingForUser = "waiting_for_user",
  /** 已完成 */
  Completed = "completed",
  /** 发生错误 */
  Error = "error",
}

/** Agent 定义接口 */
export interface AgentDef {
  /** Agent 唯一标识 */
  id: AgentId;
  /** Agent 显示名称 */
  name: string;
  /** 所使用的模型标识 */
  model: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 可用工具列表 */
  tools: ToolDef[];
  /** 生命周期钩子 */
  hooks?: Partial<Record<LifecycleHookPoint, HookFn>>;
  /** 最大对话轮次限制 */
  maxTurns?: number;
}

// ============================================================
// Model 相关类型
// ============================================================

/** 流式事件类型 */
export type StreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "tool_use"; toolName: string; toolInput: ToolInput; toolCallId: string }
  | { type: "end_turn"; stopReason: string }
  | { type: "error"; error: Error };

/** 模型响应结构 */
export interface ModelResponse {
  content: string;
  toolCalls: ToolCallMessage[];
  stopReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** 模型提供者接口 */
export interface ModelProvider {
  /** 模型提供者标识 */
  id: string;
  /** 生成流式响应 */
  generate(
    messages: Message[],
    tools: ToolDef[],
    systemPrompt: string
  ): AsyncGenerator<StreamEvent, void, unknown>;
}

// ============================================================
// Channel 相关类型
// ============================================================

/** 通道定义接口（如 CLI、WebSocket、HTTP 等） */
export interface ChannelDef {
  /** 通道标识 */
  id: string;
  /** 通道类型 */
  type: string;
  /** 启动通道 */
  start(): Promise<void>;
  /** 发送消息到通道 */
  sendMessage(message: Message): Promise<void>;
  /** 停止通道 */
  stop(): Promise<void>;
}

// ============================================================
// Storage 相关类型
// ============================================================

/** 存储提供者接口 */
export interface StorageProvider {
  /** 保存数据 */
  save(key: string, value: unknown): Promise<void>;
  /** 加载数据 */
  load<T = unknown>(key: string): Promise<T | null>;
  /** 删除数据 */
  delete(key: string): Promise<void>;
  /** 列出所有键 */
  list(prefix?: string): Promise<string[]>;
}

// ============================================================
// Orchestrator 相关类型
// ============================================================

/** 编排策略枚举 */
export enum OrchestratorStrategy {
  /** 顺序执行 */
  Sequential = "sequential",
  /** 并行执行 */
  Parallel = "parallel",
  /** 路由分发 */
  Router = "router",
  /** 监督者模式 */
  Supervisor = "supervisor",
  /** 层级结构 */
  Hierarchy = "hierarchy",
}

/** 编排器定义接口 */
export interface OrchestratorDef {
  /** 编排器标识 */
  id: string;
  /** 参与编排的 Agent 列表 */
  agents: AgentDef[];
  /** 编排策略 */
  strategy: OrchestratorStrategy;
  /** 路由函数：根据输入决定分发给哪个 Agent */
  route?: RouteFunction;
  /** 分发前的钩子 */
  beforeDispatch?(message: Message, targetAgents: AgentId[]): Promise<void>;
  /** 收集结果后的钩子 */
  afterCollect?(results: Message[], sourceAgents: AgentId[]): Promise<Message[]>;
}

// ============================================================
// SharedContext 类型
// ============================================================

/** 共享上下文，在多 Agent 间传递 */
export interface SharedContext {
  /** 对话消息历史 */
  messages: Message[];
  /** 产出物（文件、代码片段等） */
  artifacts: Record<string, unknown>;
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 父级 Agent 标识（用于层级结构） */
  parentAgentId?: AgentId;
}

// ============================================================
// Hook 相关类型
// ============================================================

/** Agent 生命周期钩子触发点（与中间件 HookPoint 不同） */
export enum LifecycleHookPoint {
  /** Agent 启动前 */
  BeforeAgentStart = "before_agent_start",
  /** Agent 启动后 */
  AfterAgentStart = "after_agent_start",
  /** 模型调用前 */
  BeforeModelCall = "before_model_call",
  /** 模型调用后 */
  AfterModelCall = "after_model_call",
  /** 工具执行前 */
  BeforeToolExec = "before_tool_exec",
  /** 工具执行后 */
  AfterToolExec = "after_tool_exec",
  /** Agent 完成后 */
  AfterAgentEnd = "after_agent_end",
  /** 发生错误时 */
  OnError = "on_error",
}

/** 钩子函数类型 */
export type HookFn = (context: SharedContext, payload?: unknown) => Promise<void> | void;

// ============================================================
// EventBus 接口
// ============================================================

/** 事件总线接口 */
export interface EventBus {
  /** 发送事件 */
  emit(event: string, payload?: unknown): void;
  /** 监听事件 */
  on(event: string, handler: (payload?: unknown) => void): void;
  /** 取消监听 */
  off(event: string, handler: (payload?: unknown) => void): void;
}

// ============================================================
// Session 相关类型
// ============================================================

/** 会话定义 */
export interface Session {
  /** 会话 ID */
  id: string;
  /** 消息列表 */
  messages: Message[];
  /** 系统提示词 */
  systemPrompt?: string;
  /** 元数据 */
  metadata: Record<string, unknown>;
}

// ============================================================
// AgentContext / AgentResult 相关类型
// ============================================================

/** Agent 执行上下文 */
export interface AgentContext {
  /** 消息列表 */
  messages: Message[];
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 外部中止信号 */
  abortSignal?: AbortSignal;
}

/** Agent 执行结果 */
export interface AgentResult {
  /** 输出文本 */
  output: string;
  /** 消息列表 */
  messages: Message[];
  /** 元数据 */
  metadata: Record<string, unknown>;
}

// ============================================================
// 模型调用相关类型
// ============================================================

/** 模型调用选项 */
export interface ModelCallOptions {
  /** 模型名称 */
  model?: string;
  /** 温度 */
  temperature?: number;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 停止序列 */
  stopSequences?: string[];
  /** 工具列表 */
  tools?: ToolDef[];
}

/** 模型调用结果 */
export interface ModelCallResult {
  /** 生成的内容 */
  content: string;
  /** 终止原因 */
  finishReason: "stop" | "length" | "tool_use";
  /** token 用量 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** 工具调用列表 */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

// ============================================================
// AgentLoop 相关类型
// ============================================================

/** 工具调用 */
export interface ToolCall {
  /** 调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 调用参数 */
  arguments: Record<string, unknown>;
}

/** 工具调用结果 */
export interface ToolCallResult {
  /** 对应的调用 ID */
  callId: string;
  /** 工具名称 */
  toolName: string;
  /** 输出内容 */
  output: unknown;
  /** 是否出错 */
  isError: boolean;
  /** 执行耗时（毫秒） */
  durationMs: number;
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  /** Agent 上下文 */
  agentContext: AgentContext;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 权限映射 */
  permissions?: Record<string, boolean>;
}

// ============================================================
// 框架事件相关类型
// ============================================================

/** 框架事件类型 */
export type FrameworkEventType =
  | "agent:start"
  | "agent:end"
  | "agent:error"
  | "orchestrator:start"
  | "orchestrator:end"
  | "tool:call"
  | "tool:result";

/** 框架事件 */
export interface FrameworkEvent {
  /** 事件类型 */
  type: FrameworkEventType;
  /** 时间戳 */
  timestamp: number;
  /** 事件数据 */
  data: Record<string, unknown>;
}

/** 事件监听器 */
export type FrameworkEventListener = (event: FrameworkEvent) => void;

// ============================================================
// 编排器扩展类型
// ============================================================

/** 编排器运行选项 */
export interface OrchestratorRunOptions {
  /** 输入文本 */
  input: string;
  /** 上下文数据 */
  context?: Record<string, unknown>;
  /** 外部中止信号 */
  abortSignal?: AbortSignal;
}

/** 编排器运行结果 */
export interface OrchestratorResult {
  /** 输出文本 */
  output: string;
  /** 各 Agent 执行结果 */
  agentResults: AgentResult[];
  /** 元数据 */
  metadata: Record<string, unknown>;
}

/** 路由函数：根据输入决定分发给哪个 Agent */
export type RouteFunction = (input: string, agents: AgentDef[]) => Promise<AgentDef | AgentDef[]>;

// ============================================================
// 框架运行选项
// ============================================================

/** 框架 run() 方法的选项 */
export interface FrameworkRunOptions {
  /** 指定编排器名称 */
  orchestrator?: string;
  /** 指定模型名称 */
  model?: string;
  /** 上下文数据 */
  context?: Record<string, unknown>;
  /** 外部中止信号 */
  abortSignal?: AbortSignal;
}

// ============================================================
// Workspace / Sandbox 类型
// ============================================================

/** 沙箱类型 */
export type WorkspaceType = "local" | "docker" | "e2b";

/** 沙箱配置 */
export interface WorkspaceConfig {
  /** 沙箱类型 */
  type: WorkspaceType;
  /** 工作目录 */
  workDir: string;
  /** 资源限制 */
  limits?: {
    /** CPU 数量 */
    cpu?: number;
    /** 内存限制 (MB) */
    memory?: number;
    /** 磁盘限制 (MB) */
    disk?: number;
    /** 超时时间 (ms) */
    timeout?: number;
  };
  /** Docker 专用配置 */
  docker?: {
    /** 镜像名 */
    image: string;
    /** 容器名 */
    containerName?: string;
    /** 挂载卷 */
    volumes?: string[];
    /** 网络模式 */
    networkMode?: string;
    /** 环境变量 */
    env?: Record<string, string>;
  };
  /** 文件系统策略 */
  filesystem?: {
    /** 只允许读取这些目录 */
    allowedReadDirs?: string[];
    /** 只允许写入这些目录 */
    allowedWriteDirs?: string[];
    /** 禁止的文件扩展名 */
    forbiddenExtensions?: string[];
  };
}

/** 命令执行结果 */
export interface CommandResult {
  /** 退出码 */
  exitCode: number;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 执行耗时 (ms) */
  durationMs: number;
  /** 是否超时 */
  timedOut: boolean;
}

/** 文件操作类型 */
export type FileOperation = "read" | "write" | "delete" | "list" | "exists";

/** 文件操作结果 */
export interface FileResult {
  /** 操作类型 */
  operation: FileOperation;
  /** 文件路径 */
  path: string;
  /** 文件内容（读操作时有效） */
  content?: string;
  /** 是否成功 */
  success: boolean;
  /** 文件列表（list 操作时有效） */
  files?: string[];
  /** 错误信息 */
  error?: string;
}

/** 工作空间状态 */
export type WorkspaceStatus = "created" | "running" | "stopped" | "error";
