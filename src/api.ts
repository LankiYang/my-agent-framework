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
import type { AgentLoopEvent, AgentLoopTerminal } from "./runtime/agent-loop.js";
import { HookPoint, type MiddlewareFn, HookRegistry } from "./runtime/middleware.js";
import { PermissionMode } from "./runtime/permission.js";
import { Toolkit } from "./runtime/tool-group.js";
import { CLIChannel } from "./provider/channel/cli-channel.js";
import { ClaudeModelProvider } from "./provider/model/claude.js";
import { OpenAIModelProvider } from "./provider/model/openai.js";
import type { ExecutionEnv } from "./provider/env.js";
import { formatSkillsForPrompt, type Skill } from "./runtime/skills.js";

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
  /** 上下文压缩预算（token）。设置后启用 compaction，Agent 可长时间运行不撑爆上下文 */
  contextBudget?: number;
  /** 技能列表：其 name+description+指令会注入 system prompt，指导模型何时如何做某类任务 */
  skills?: Skill[];
  /** 中间件列表（可选 hookPoint，缺省挂到 onReply） */
  middleware?: Array<{ name: string; fn: MiddlewareFn; hookPoint?: HookPoint }>;
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

  let permissionMode: PermissionMode | undefined;
  if (config.permissionMode !== undefined) {
    const raw = config.permissionMode as string;
    // 同时接受枚举 key（"Bypass"）与枚举值（"bypass"）
    const byKey = (PermissionMode as Record<string, string>)[raw];
    const values = Object.values(PermissionMode) as string[];
    if (byKey && values.includes(byKey)) {
      permissionMode = byKey as PermissionMode;
    } else if (values.includes(raw)) {
      permissionMode = raw as PermissionMode;
    } else {
      throw new Error(
        `createAgent("${config.name}"): 无效的 permissionMode "${raw}"。` +
          `可选值: [${values.join(", ")}] 或对应枚举键 [${Object.keys(PermissionMode).join(", ")}]。`,
      );
    }
  }

  // 把技能指导追加到系统提示词
  const basePrompt = config.prompt ?? "";
  const skillsBlock = config.skills && config.skills.length > 0
    ? formatSkillsForPrompt(config.skills)
    : "";
  const systemPrompt = skillsBlock ? `${basePrompt}\n\n${skillsBlock}` : basePrompt;

  return {
    id: agentId,
    name: config.name,
    model: modelId,
    modelProvider: typeof config.model === "string" ? undefined : config.model,
    systemPrompt,
    tools: config.tools ?? [],
    maxTurns: config.maxTurns,
    contextBudget: config.contextBudget,
    permissionMode,
    middleware: config.middleware,
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
  /** 执行环境（ExecutionEnv）。内置 read/write/bash 工具经它访问系统；缺省用 NodeExecutionEnv */
  env?: ExecutionEnv;
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
  /** 运行单次对话；options 可指定 agent、sessionId（多轮会话）、userId */
  chat(input: string, options?: { agent?: string; sessionId?: string; userId?: string }): Promise<AgentResult>;
  /** 流式运行单次对话：yield agentLoop 事件；options 同 chat */
  chatStream(input: string, options?: { agent?: string; sessionId?: string; userId?: string }): AsyncGenerator<AgentLoopEvent, AgentLoopTerminal>;
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

  // 注册执行环境（内置工具会用）
  if (config.env) {
    framework.useEnv(config.env);
  }

  // 自动收集各 Agent 携带的 modelProvider 实例并注册（去重），
  // 使 createAgent({ model: providerInstance }) 无需再手动 useModel。
  if (config.agents) {
    for (const agent of config.agents) {
      const mp = agent.modelProvider;
      if (mp && !framework.getModel(mp.id)) {
        framework.useModel(mp);
      }
    }
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

    async chat(input: string, options?: { agent?: string; sessionId?: string; userId?: string }): Promise<AgentResult> {
      if (!framework.isRunning) {
        await framework.start();
      }
      return framework.run(input, options);
    },

    async *chatStream(input: string, options?: { agent?: string; sessionId?: string; userId?: string }) {
      if (!framework.isRunning) {
        await framework.start();
      }
      return yield* framework.runStream(input, options);
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

      // 查找参与编排的 Agent（按 id 或 name，与 framework.run 一致）
      const agents: AgentDef[] = [];
      const missing: string[] = [];
      for (const key of orchestrateConfig.agents) {
        const agent = framework.resolveAgent(key);
        if (agent) {
          agents.push(agent);
        } else {
          missing.push(key);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `orchestrate 未找到 Agent: [${missing.join(", ")}]。` +
            `（agents 接受 id 或 name）`,
        );
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

      // per-run 传入真实执行器：用 app 自身的 framework 驱动 agentLoop（并发安全）
      return orchestrator.run({
        input: orchestrateConfig.input,
        context: orchestrateConfig.context,
        executor: (agent, agentInput) => framework.run(agentInput, { agent: agent.id }),
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
      return new ClaudeModelProvider({
        apiKey: claudeConfig.apiKey,
        model: claudeConfig.model,
        baseURL: claudeConfig.baseURL,
      });
    }
    case "openai": {
      const openaiConfig = config as OpenAIModelConfig;
      return new OpenAIModelProvider({
        apiKey: openaiConfig.apiKey,
        model: openaiConfig.model,
        baseURL: openaiConfig.baseURL,
      });
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
  /**
   * 把整条编排包装成一个 AgentDef，使其可作为单元嵌套进另一条编排。
   * 解锁 pipe(coder, parallel(a, b).asAgent(), reviewer) 这类组合。
   * @param name 嵌套单元的显示名（默认按策略生成）
   */
  asAgent(name?: string): AgentDef;
}

/**
 * 把一条 Pipeline 包装成 AgentDef：其内部模型即"运行这条 pipeline"。
 * 外层编排像调用普通 Agent 一样调用它，实现任意层级嵌套。
 */
function makePipelineAgent(pipeline: Pipeline, name: string): AgentDef {
  const id = `nested-${pipeline.strategy}-${name.toLowerCase().replace(/\s+/g, "-")}`;
  const provider: ModelProvider = {
    id: `nested-provider-${id}`,
    async *generate(messages) {
      // 取最后一条 user 消息作为 pipeline 输入
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const input = lastUser?.content ?? "";
      const result = await pipeline.run(input);
      yield { type: "content_delta", delta: result.output };
      yield { type: "end_turn", stopReason: "end_turn" };
    },
  };
  return {
    id,
    name,
    model: provider.id,
    modelProvider: provider, // 让 buildFrameworkExecutor 能自动注册
    systemPrompt: "",
    tools: [],
    maxTurns: 1,
  };
}

/**
 * 用一个临时 Framework 承载 agents，返回可注入编排器的 AgentExecutor。
 * 负责注册每个 Agent 的 modelProvider（去重）与 Agent 本身，
 * 并以 framework.run(input, { agent }) 真正驱动 agentLoop。
 */
async function buildFrameworkExecutor(agents: AgentDef[]): Promise<{
  executor: (agent: AgentDef, input: string) => Promise<AgentResult>;
  framework: Framework;
}> {
  const framework = new Framework();
  const registeredModels = new Set<string>();

  for (const agent of agents) {
    if (agent.modelProvider && !registeredModels.has(agent.modelProvider.id)) {
      framework.useModel(agent.modelProvider);
      registeredModels.add(agent.modelProvider.id);
    }
    if (!framework.getAgent(agent.id)) {
      framework.useAgent(agent);
    }
  }

  if (!framework.isRunning) {
    await framework.start();
  }

  const executor = (agent: AgentDef, input: string): Promise<AgentResult> =>
    framework.run(input, { agent: agent.id });

  return { executor, framework };
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
  const self: Pipeline = {
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
      const { executor, framework } = await buildFrameworkExecutor(agents);
      try {
        return await orchestrator.run({
          input,
          context,
          executor: (agent, agentInput) => executor(agent, agentInput),
        });
      } finally {
        await framework.stop(); // 清理内部临时 Framework，避免资源泄漏
      }
    },
    asAgent(name?: string): AgentDef {
      return makePipelineAgent(self, name ?? "SequentialPipeline");
    },
  };
  return self;
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
  const self: Pipeline = {
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
      const { executor, framework } = await buildFrameworkExecutor(agents);
      try {
        return await orchestrator.run({
          input,
          context,
          executor: (agent, agentInput) => executor(agent, agentInput),
        });
      } finally {
        await framework.stop(); // 清理内部临时 Framework，避免资源泄漏
      }
    },
    asAgent(name?: string): AgentDef {
      return makePipelineAgent(self, name ?? "ParallelPipeline");
    },
  };
  return self;
}

// ============================================================
// 8b. agentAsTool — 把一个 Agent 包装成工具（Agent 组合 / 层级）
// ============================================================

/** agentAsTool 配置 */
export interface AgentAsToolConfig {
  /** 暴露给上层 Agent 的工具名（默认 ask_<agent-slug>） */
  name?: string;
  /** 工具描述（建议自定义以帮助上层模型决策） */
  description?: string;
  /**
   * 复用的 Framework 实例。不传时内部自建一个（并在每次调用后清理）。
   * 传入可复用同一运行时（推荐在编排/多次调用场景）。
   */
  framework?: Framework;
  /** 从工具输入里取哪个字段作为子 Agent 的输入文本（默认 "input"） */
  inputKey?: string;
}

/**
 * 把一个 Agent 包装成 ToolDef，使它能作为另一个 Agent 的工具被调用。
 * 解锁 supervisor-as-tool、递归分解、层级多 Agent 等组合模式。
 *
 * @example
 * const researcher = createAgent({ name: 'Researcher', model: claude, tools: [webSearch] });
 * const writer = createAgent({
 *   name: 'Writer',
 *   model: claude,
 *   tools: [agentAsTool(researcher, { description: '就某主题做资料调研，返回要点' })],
 * });
 */
export function agentAsTool(agent: AgentDef, config: AgentAsToolConfig = {}): ToolDef {
  const toolName = config.name ?? `ask_${agent.name.toLowerCase().replace(/\s+/g, "_")}`;
  const inputKey = config.inputKey ?? "input";

  return {
    name: toolName,
    description:
      config.description ??
      `把任务委派给「${agent.name}」子 Agent 处理，返回它的最终输出。`,
    inputSchema: {
      type: "object",
      properties: {
        [inputKey]: { type: "string", description: `交给「${agent.name}」处理的任务描述` },
      },
      required: [inputKey],
    },
    isReadOnly: false,
    isConcurrencySafe: true,
    execute: async (input) => {
      const task = String(input[inputKey] ?? "");

      // 复用传入的 framework；否则自建并在结束后清理，避免资源泄漏
      const external = config.framework;
      const framework = external ?? new Framework();

      // 确保子 Agent 的模型与定义已注册
      if (agent.modelProvider && !framework.getModel(agent.modelProvider.id)) {
        framework.useModel(agent.modelProvider);
      }
      if (!framework.getAgent(agent.id)) {
        framework.useAgent(agent);
      }
      // 无论复用还是自建，都必须已启动才能 run
      if (!framework.isRunning) {
        await framework.start();
      }

      try {
        const result = await framework.run(task, { agent: agent.id });
        return { content: result.output };
      } finally {
        // 只清理自建的 framework；外部传入的由调用方负责生命周期
        if (!external) {
          await framework.stop();
        }
      }
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
