/**
 * 面向开发者的高层抽象 API
 *
 * 设计原则：
 * - 声明式优先 — 通过配置描述 Agent
 * - 约定优于配置 — 合理默认值，最少配置即可运行
 * - 一行代码 — 常见操作一行搞定
 * - 类型安全 — 利用 TypeScript 泛型推断输入/输出类型
 * - 可组合 — 工具、Agent、中间件都可自由组合
 */

import type {
  ToolDef,
  AgentDef,
  ModelProvider,
  ChannelDef,
  OrchestratorStrategy,
  Message,
  SharedContext,
  StreamEvent,
  ToolInput,
  ToolOutput,
  StorageProvider,
  AgentResult,
  WorkspaceConfig,
  OrchestratorResult,
} from "./core/types.js";
import { Framework } from "./index.js";
import { HookPoint, type MiddlewareFn, HookRegistry } from "./runtime/middleware.js";
import { PermissionMode } from "./runtime/permission.js";
import { Toolkit } from "./runtime/tool-group.js";
import { CLIChannel } from "./provider/channel/cli-channel.js";

// ============================================================
// 1. createTool — 极简工具定义
// ============================================================

/** 完整工具配置（对象形式） */
export interface ToolConfig<TInput extends ToolInput = ToolInput> {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  execute: (input: TInput, context: SharedContext) => Promise<string | ToolOutput>;
  readOnly?: boolean;
  concurrencySafe?: boolean;
}

/**
 * 创建工具 — 对象配置形式
 *
 * @example
 * const bash = createTool({
 *   name: 'bash',
 *   description: '执行命令',
 *   schema: { command: { type: 'string', required: true } },
 *   execute: async ({ command }) => execSync(command).toString(),
 * })
 */
export function createTool<TInput extends ToolInput = ToolInput>(config: ToolConfig<TInput>): ToolDef;

/**
 * 创建工具 — 极简三参数形式（自动推断 schema）
 *
 * @example
 * const echo = createTool('echo', '回显输入', async (input: { text: string }) => input.text)
 */
export function createTool<TInput extends ToolInput = ToolInput>(
  name: string,
  description: string,
  handler: (input: TInput, context: SharedContext) => Promise<string | ToolOutput>,
): ToolDef;

export function createTool<TInput extends ToolInput = ToolInput>(
  nameOrConfig: string | ToolConfig<TInput>,
  description?: string,
  handler?: (input: TInput, context: SharedContext) => Promise<string | ToolOutput>,
): ToolDef {
  // 对象配置形式
  if (typeof nameOrConfig === "object") {
    const config = nameOrConfig;
    return {
      name: config.name,
      description: config.description,
      inputSchema: config.schema ?? {},
      isReadOnly: config.readOnly ?? true,
      isConcurrencySafe: config.concurrencySafe ?? true,
      execute: async (input: ToolInput, context: SharedContext): Promise<ToolOutput> => {
        const result = await config.execute(input as TInput, context);
        if (typeof result === "string") {
          return { content: result };
        }
        return result;
      },
    };
  }

  // 三参数形式
  const executeFn = handler!;
  return {
    name: nameOrConfig,
    description: description!,
    inputSchema: {},
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async (input: ToolInput, context: SharedContext): Promise<ToolOutput> => {
      const result = await executeFn(input as TInput, context);
      if (typeof result === "string") {
        return { content: result };
      }
      return result;
    },
  };
}

// ============================================================
// 2. createAgent — 声明式 Agent 定义
// ============================================================

/** Agent 创建配置 */
export interface AgentConfig {
  /** Agent 名称 */
  name: string;
  /** Agent 描述 */
  description?: string;
  /** 模型标识字符串或 ModelProvider 实例 */
  model: string | ModelProvider;
  /** 系统提示词 */
  prompt?: string;
  /** 工具列表 */
  tools?: ToolDef[];
  /** 最大对话轮次 */
  maxTurns?: number;
  /** 中间件列表 */
  middleware?: Array<{ name: string; fn: MiddlewareFn }>;
  /** 权限模式 */
  permissionMode?: keyof typeof PermissionMode | PermissionMode;
}

/**
 * 声明式创建 Agent
 *
 * @example
 * const agent = createAgent({
 *   name: 'Coder',
 *   description: '编程助手',
 *   model: 'claude-3.5-sonnet',
 *   prompt: '你是一个编程助手',
 *   tools: [readFile, writeFile],
 *   maxTurns: 50,
 * })
 */
export function createAgent(config: AgentConfig): AgentDef {
  const modelId = typeof config.model === "string"
    ? config.model
    : config.model.id;

  const agentId = `agent-${config.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now().toString(36)}`;

  return {
    id: agentId,
    name: config.name,
    model: modelId,
    systemPrompt: config.prompt ?? "",
    tools: config.tools ?? [],
    maxTurns: config.maxTurns,
  };
}

// ============================================================
// 3. createApp — 应用入口（最高层抽象）
// ============================================================

/** 应用配置 */
export interface AppConfig {
  /** Agent 列表 */
  agents?: AgentDef[];
  /** 全局工具（所有 Agent 共享） */
  tools?: ToolDef[];
  /** 默认模型 */
  model?: ModelProvider;
  /** 工作空间配置 */
  workspace?: WorkspaceConfig;
  /** 存储配置 */
  storage?: "memory" | "file" | StorageProvider;
}

/** 监听配置 */
export interface ListenConfig {
  /** 渠道类型 */
  channel: string;
  /** 端口（HTTP 渠道使用） */
  port?: number;
  /** 其他配置 */
  [key: string]: unknown;
}

/** 编排配置 */
export interface OrchestrateConfig {
  /** 编排策略 */
  strategy: "sequential" | "parallel" | "router" | "supervisor";
  /** 参与的 Agent 名称列表 */
  agents: string[];
  /** 输入文本 */
  input: string;
  /** 上下文数据 */
  context?: Record<string, unknown>;
}

/** 应用实例接口 */
export interface App {
  /** 内部 Framework 实例 */
  framework: Framework;
  /** 运行单次对话 */
  chat(input: string): Promise<AgentResult>;
  /** 监听渠道 */
  listen(config: ListenConfig): Promise<void>;
  /** 编排多 Agent */
  orchestrate(config: OrchestrateConfig): Promise<OrchestratorResult>;
}

/**
 * 创建应用实例 — 最高层抽象
 *
 * @example
 * const app = createApp({
 *   agents: [coder, reviewer],
 *   tools: [readFile, writeFile],
 *   model: claudeProvider,
 * })
 * const result = await app.chat('写一个 hello world')
 */
export function createApp(config: AppConfig): App {
  const framework = new Framework();

  // 注册默认模型
  if (config.model) {
    framework.useModel(config.model);
  }

  // 注册全局工具
  if (config.tools) {
    for (const tool of config.tools) {
      framework.useTool(tool);
    }
  }

  // 注册 Agent（把全局工具附加到每个 Agent）
  if (config.agents) {
    for (const agent of config.agents) {
      // 将全局工具合并到 Agent 的工具列表中
      const mergedTools = [...agent.tools];
      if (config.tools) {
        for (const tool of config.tools) {
          if (!mergedTools.find((t) => t.name === tool.name)) {
            mergedTools.push(tool);
          }
        }
      }
      const enhancedAgent: AgentDef = { ...agent, tools: mergedTools };
      framework.useAgent(enhancedAgent);
    }
  }

  // 注册工作空间
  if (config.workspace) {
    framework.useWorkspace("default", config.workspace);
  }

  const app: App = {
    framework,

    async chat(input: string): Promise<AgentResult> {
      if (!framework.isRunning) {
        await framework.start();
      }
      return framework.run(input);
    },

    async listen(_config: ListenConfig): Promise<void> {
      if (!framework.isRunning) {
        await framework.start();
      }
      // 渠道监听由 Framework 的 Channel 机制处理
      // 此处作为高层 API 的占位，实际的 Channel 需通过 framework.useChannel 注册
    },

    async orchestrate(orchestrateConfig: OrchestrateConfig): Promise<OrchestratorResult> {
      if (!framework.isRunning) {
        await framework.start();
      }

      // 查找参与编排的 Agent
      const agents: AgentDef[] = [];
      for (const name of orchestrateConfig.agents) {
        // 按名称或 ID 查找
        const agent = framework.getAgent(name);
        if (agent) {
          agents.push(agent);
        }
      }

      if (agents.length === 0) {
        throw new Error("编排配置中未找到任何有效的 Agent");
      }

      // 动态创建编排器
      const orchestratorId = `orch-${Date.now().toString(36)}`;
      const { createOrchestrator } = await import("./orchestrator/index.js");
      const orchestrator = createOrchestrator({
        def: {
          id: orchestratorId,
          agents,
          strategy: orchestrateConfig.strategy as unknown as import("./core/types.js").OrchestratorStrategy,
        },
      });

      return orchestrator.run({
        input: orchestrateConfig.input,
        context: orchestrateConfig.context,
      });
    },
  };

  return app;
}

// ============================================================
// 4. createMiddleware — 中间件便捷创建
// ============================================================

/** 中间件上下文（简化版） */
export interface SimpleMiddlewareContext {
  /** Agent 唯一标识 */
  agentId: string;
  /** 对话消息列表 */
  messages: Message[];
  /** 系统提示词 */
  systemPrompt: string;
  /** 允许扩展任意属性 */
  [key: string]: unknown;
}

/** 中间件 next 函数 */
export type SimpleNextFn = () => Promise<void>;

/**
 * 中间件处理函数类型
 * 支持洋葱模型：在 next() 前后分别执行逻辑
 */
export type SimpleMiddlewareHandler = (
  ctx: SimpleMiddlewareContext,
  next: SimpleNextFn,
) => Promise<void>;

/**
 * 创建中间件 — 便捷工厂
 *
 * @example
 * const logger = createMiddleware('logger', async (ctx, next) => {
 *   console.log(`[${ctx.agentId}] 开始处理`)
 *   await next()
 *   console.log(`[${ctx.agentId}] 处理完成`)
 * })
 */
export function createMiddleware(
  name: string,
  handler: SimpleMiddlewareHandler,
): { name: string; fn: MiddlewareFn } {
  const fn: MiddlewareFn = async (context, next) => {
    const simpleCtx: SimpleMiddlewareContext = {
      agentId: context.agentId,
      messages: context.messages,
      systemPrompt: context.systemPrompt,
    };
    await handler(simpleCtx, async () => {
      // 同步回写可能被修改的字段
      context.messages = simpleCtx.messages;
      context.systemPrompt = simpleCtx.systemPrompt;
      await next();
    });
  };
  return { name, fn };
}

// ============================================================
// 5. createChannel — 渠道便捷创建
// ============================================================

/** CLI 渠道配置 */
export interface CLIChannelConfig {
  /** 提示符 */
  prompt?: string;
}

/** HTTP 渠道配置 */
export interface HTTPChannelConfig {
  /** 监听端口 */
  port: number;
  /** 监听地址 */
  host?: string;
}

/** 自定义渠道配置 */
export interface CustomChannelConfig {
  /** 渠道名称 */
  name: string;
  /** 启动函数 */
  start: (onMessage: (message: Message) => Promise<void>) => Promise<void>;
  /** 发送消息函数 */
  sendMessage: (message: Message) => Promise<void>;
  /** 停止函数 */
  stop?: () => Promise<void>;
}

/**
 * 创建渠道 — 便捷工厂
 *
 * @example
 * const cli = createChannel('cli')
 * const http = createChannel('http', { port: 3000 })
 * const custom = createChannel('custom', { name: 'wecom', start: ..., sendMessage: ... })
 */
export function createChannel(type: "cli", config?: CLIChannelConfig): ChannelDef;
export function createChannel(type: "http", config: HTTPChannelConfig): ChannelDef;
export function createChannel(type: "custom", config: CustomChannelConfig): ChannelDef;
export function createChannel(
  type: "cli" | "http" | "custom",
  config?: CLIChannelConfig | HTTPChannelConfig | CustomChannelConfig,
): ChannelDef {
  switch (type) {
    case "cli": {
      const cliConfig = config as CLIChannelConfig | undefined;
      const channel = new CLIChannel({
        prompt: cliConfig?.prompt,
      });
      return channel;
    }
    case "http": {
      const httpConfig = config as HTTPChannelConfig;
      return {
        id: `channel-http-${httpConfig.port}`,
        type: "http",
        start: async () => { /* HTTP 服务器启动 */ },
        sendMessage: async (_message: Message) => { /* HTTP 响应 */ },
        stop: async () => { /* HTTP 服务器停止 */ },
      };
    }
    case "custom": {
      const customConfig = config as CustomChannelConfig;
      let onMessageHandler: ((message: Message) => Promise<void>) | null = null;
      return {
        id: `channel-${customConfig.name}`,
        type: customConfig.name,
        start: async () => {
          await customConfig.start(async (message) => {
            if (onMessageHandler) {
              await onMessageHandler(message);
            }
          });
        },
        sendMessage: async (message: Message) => {
          await customConfig.sendMessage(message);
        },
        stop: async () => {
          if (customConfig.stop) {
            await customConfig.stop();
          }
          onMessageHandler = null;
        },
      };
    }
  }
}

// ============================================================
// 6. createModel — 模型便捷创建
// ============================================================

/** Claude 模型配置 */
export interface ClaudeModelConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/** OpenAI 模型配置 */
export interface OpenAIModelConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/** 自定义模型配置 */
export interface CustomModelConfig {
  /** 模型标识 */
  id?: string;
  /** 自定义流式生成器 */
  generate: (
    messages: Message[],
    tools: ToolDef[],
    systemPrompt: string,
  ) => AsyncGenerator<StreamEvent, void, unknown>;
}

/**
 * 创建模型 — 便捷工厂
 *
 * @example
 * const claude = createModel('claude', { apiKey: '...', model: 'claude-sonnet-4-20250514' })
 * const gpt = createModel('openai', { apiKey: '...', model: 'gpt-4o' })
 * const custom = createModel('custom', { generate: async function* (...) { ... } })
 */
export function createModel(type: "claude", config: ClaudeModelConfig): ModelProvider;
export function createModel(type: "openai", config: OpenAIModelConfig): ModelProvider;
export function createModel(type: "custom", config: CustomModelConfig): ModelProvider;
export function createModel(
  type: "claude" | "openai" | "custom",
  config: ClaudeModelConfig | OpenAIModelConfig | CustomModelConfig,
): ModelProvider {
  switch (type) {
    case "claude": {
      const claudeConfig = config as ClaudeModelConfig;
      const modelName = claudeConfig.model ?? "claude-sonnet-4-20250514";
      return {
        id: `claude-${modelName}`,
        async *generate(
          _messages: Message[],
          _tools: ToolDef[],
          _systemPrompt: string,
        ): AsyncGenerator<StreamEvent, void, unknown> {
          // Claude API 集成占位 — 实际项目中接入 Anthropic SDK
          yield { type: "content_delta", delta: `[Claude ${modelName}] 响应占位` };
          yield { type: "end_turn", stopReason: "end_turn" };
        },
      };
    }
    case "openai": {
      const openaiConfig = config as OpenAIModelConfig;
      const modelName = openaiConfig.model ?? "gpt-4o";
      return {
        id: `openai-${modelName}`,
        async *generate(
          _messages: Message[],
          _tools: ToolDef[],
          _systemPrompt: string,
        ): AsyncGenerator<StreamEvent, void, unknown> {
          // OpenAI API 集成占位 — 实际项目中接入 OpenAI SDK
          yield { type: "content_delta", delta: `[OpenAI ${modelName}] 响应占位` };
          yield { type: "end_turn", stopReason: "end_turn" };
        },
      };
    }
    case "custom": {
      const customConfig = config as CustomModelConfig;
      return {
        id: customConfig.id ?? `custom-model-${Date.now().toString(36)}`,
        generate: customConfig.generate,
      };
    }
  }
}

// ============================================================
// 7. pipe / parallel — 编排便捷语法
// ============================================================

/** 编排管道结果接口 */
export interface Pipeline {
  /** 参与编排的 Agent 列表 */
  agents: AgentDef[];
  /** 编排策略 */
  strategy: "sequential" | "parallel";
  /** 执行编排 */
  run(input: string, context?: Record<string, unknown>): Promise<OrchestratorResult>;
}

/**
 * 流水线编排 — 顺序执行多个 Agent
 * 前一个 Agent 的输出作为下一个 Agent 的输入
 *
 * @example
 * const pipeline = pipe(coder, reviewer, tester)
 * const result = await pipeline.run('写一个排序算法')
 */
export function pipe(...agents: AgentDef[]): Pipeline {
  return {
    agents,
    strategy: "sequential",
    async run(input: string, context?: Record<string, unknown>): Promise<OrchestratorResult> {
      const { createOrchestrator } = await import("./orchestrator/index.js");
      const orchestrator = createOrchestrator({
        def: {
          id: `pipe-${Date.now().toString(36)}`,
          agents,
          strategy: "sequential" as unknown as import("./core/types.js").OrchestratorStrategy,
        },
      });
      return orchestrator.run({ input, context });
    },
  };
}

/**
 * 并行编排 — 同时执行多个 Agent
 * 所有 Agent 接收相同的输入，最终汇总结果
 *
 * @example
 * const analysis = parallel(securityAgent, performanceAgent, styleAgent)
 * const result = await analysis.run('分析这段代码')
 */
export function parallel(...agents: AgentDef[]): Pipeline {
  return {
    agents,
    strategy: "parallel",
    async run(input: string, context?: Record<string, unknown>): Promise<OrchestratorResult> {
      const { createOrchestrator } = await import("./orchestrator/index.js");
      const orchestrator = createOrchestrator({
        def: {
          id: `parallel-${Date.now().toString(36)}`,
          agents,
          strategy: "parallel" as unknown as import("./core/types.js").OrchestratorStrategy,
        },
      });
      return orchestrator.run({ input, context });
    },
  };
}

// ============================================================
// 8. toolbox — 批量工具定义
// ============================================================

/** 单个工具项配置 */
export interface ToolboxItemConfig<TInput extends ToolInput = ToolInput> {
  /** 工具描述 */
  description: string;
  /** 执行函数 */
  execute: (input: TInput, context: SharedContext) => Promise<string | ToolOutput>;
  /** 是否只读 */
  readOnly?: boolean;
  /** 是否并发安全 */
  concurrencySafe?: boolean;
  /** 输入 schema */
  schema?: Record<string, unknown>;
}

/** 从 ToolboxItemConfig 记录推断出 ToolDef 记录的类型 */
export type ToolboxResult<T extends Record<string, ToolboxItemConfig>> = {
  [K in keyof T]: ToolDef;
};

/**
 * 批量定义工具 — toolbox 辅助函数
 *
 * @example
 * const fileTools = toolbox('file', {
 *   read: {
 *     description: '读取文件',
 *     execute: async ({ path }) => fs.readFileSync(path, 'utf-8'),
 *   },
 *   write: {
 *     description: '写入文件',
 *     execute: async ({ path, content }) => { fs.writeFileSync(path, content); return 'ok'; },
 *     readOnly: false,
 *   },
 * })
 */
export function toolbox<T extends Record<string, ToolboxItemConfig>>(
  namespace: string,
  definitions: T,
): ToolboxResult<T> {
  const result = {} as Record<string, ToolDef>;

  for (const [key, config] of Object.entries(definitions)) {
    const toolName = `${namespace}.${key}`;
    result[key] = {
      name: toolName,
      description: config.description,
      inputSchema: config.schema ?? {},
      isReadOnly: config.readOnly ?? true,
      isConcurrencySafe: config.concurrencySafe ?? true,
      execute: async (input: ToolInput, context: SharedContext): Promise<ToolOutput> => {
        const res = await config.execute(input, context);
        if (typeof res === "string") {
          return { content: res };
        }
        return res;
      },
    };
  }

  return result as ToolboxResult<T>;
}

// ============================================================
// 导出所有公共 API
// ============================================================

export {
  // 重导出依赖模块中有用的类型/枚举
  HookPoint,
  PermissionMode,
  Toolkit,
  HookRegistry,
};

export type {
  MiddlewareFn,
};
