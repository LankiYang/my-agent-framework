/**
 * 编排器模块
 * 提供多种 Agent 编排策略：顺序执行、并行执行、路由分发、监督者模式
 */

import type {
  AgentDef,
  AgentId,
  AgentContext,
  AgentResult,
  OrchestratorDef,
  OrchestratorRunOptions,
  OrchestratorResult,
  RouteFunction,
  FrameworkEvent,
  FrameworkEventType,
  FrameworkEventListener,
  Message,
  OrchestratorStrategy,
} from "../core/types.js";

// ============ 基础编排器抽象类 ============

/** Agent 执行函数类型 */
export type AgentExecutorFn = (agent: AgentDef, input: string, context: AgentContext) => Promise<AgentResult>;

/**
 * BaseOrchestrator 抽象类
 * 实现公共逻辑：日志、事件发射、错误处理
 */
export abstract class BaseOrchestrator {
  readonly id: string;
  readonly agents: AgentDef[];

  private listeners: Map<FrameworkEventType, Set<FrameworkEventListener>> = new Map();
  private agentExecutorFn?: AgentExecutorFn;

  constructor(def: OrchestratorDef) {
    this.id = def.id;
    this.agents = def.agents;
  }

  /** 注入 Agent 执行函数（由 Framework 提供，内部调用 agentLoop） */
  setAgentExecutor(fn: AgentExecutorFn): void {
    this.agentExecutorFn = fn;
  }

  /** 注册事件监听器 */
  on(type: FrameworkEventType, listener: FrameworkEventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  /** 移除事件监听器 */
  off(type: FrameworkEventType, listener: FrameworkEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** 发射事件 */
  protected emit(type: FrameworkEventType, data: Record<string, unknown>): void {
    const event: FrameworkEvent = {
      type,
      timestamp: Date.now(),
      data,
    };
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  /** 日志输出 */
  protected log(message: string, ...args: unknown[]): void {
    console.log(`[Orchestrator:${this.id}] ${message}`, ...args);
  }

  /** 执行单个 Agent（优先使用注入的执行函数，否则回退到 echo） */
  protected async executeAgent(agent: AgentDef, input: string, context: AgentContext): Promise<AgentResult> {
    this.emit("agent:start", { agentId: agent.id, agentName: agent.name });

    try {
      let result: AgentResult;

      if (this.agentExecutorFn) {
        result = await this.agentExecutorFn(agent, input, context);
      } else {
        const messages: Message[] = [
          ...context.messages,
          { id: `msg-${Date.now()}`, role: "user", type: "text", content: input, timestamp: Date.now() },
        ];
        result = {
          output: input,
          messages,
          metadata: { agentId: agent.id, agentName: agent.name },
        };
      }

      this.emit("agent:end", { agentId: agent.id, output: result.output });
      return result;
    } catch (error) {
      this.emit("agent:error", { agentId: agent.id, error });
      throw error;
    }
  }

  /** 抽象方法：子类实现具体编排逻辑 */
  abstract run(options: OrchestratorRunOptions): Promise<OrchestratorResult>;
}

// ============ 顺序编排器 ============

/**
 * SequentialOrchestrator
 * A → B → C 串行流水线，前一个的输出作为下一个的输入
 */
export class SequentialOrchestrator extends BaseOrchestrator {
  constructor(def: OrchestratorDef) {
    super(def);
  }

  async run(options: OrchestratorRunOptions): Promise<OrchestratorResult> {
    this.emit("orchestrator:start", { id: this.id, strategy: "sequential" });
    this.log("开始顺序执行，共 %d 个 Agent", this.agents.length);

    if (this.agents.length === 0) {
      throw new Error(`SequentialOrchestrator "${this.id}" 没有配置 Agent`);
    }

    const agentResults: AgentResult[] = [];
    let currentInput = options.input;

    for (const agent of this.agents) {
      if (options.abortSignal?.aborted) {
        break;
      }

      const context: AgentContext = {
        messages: [],
        metadata: { ...options.context, previousResults: agentResults },
        abortSignal: options.abortSignal,
      };

      const result = await this.executeAgent(agent, currentInput, context);
      agentResults.push(result);

      // 将当前 Agent 的输出作为下一个 Agent 的输入
      currentInput = result.output;
    }

    const finalOutput = agentResults.length > 0
      ? agentResults[agentResults.length - 1]!.output
      : "";

    this.emit("orchestrator:end", { id: this.id, output: finalOutput });

    return {
      output: finalOutput,
      agentResults,
      metadata: { strategy: "sequential", agentCount: this.agents.length },
    };
  }
}

// ============ 并行编排器 ============

/**
 * ParallelOrchestrator
 * 同时分发给多个 Agent，汇总结果
 */
export class ParallelOrchestrator extends BaseOrchestrator {
  constructor(def: OrchestratorDef) {
    super(def);
  }

  async run(options: OrchestratorRunOptions): Promise<OrchestratorResult> {
    this.emit("orchestrator:start", { id: this.id, strategy: "parallel" });
    this.log("开始并行执行，共 %d 个 Agent", this.agents.length);

    const tasks = this.agents.map((agent) => {
      const context: AgentContext = {
        messages: [],
        metadata: { ...options.context },
        abortSignal: options.abortSignal,
      };
      return this.executeAgent(agent, options.input, context);
    });

    const results = await Promise.allSettled(tasks);

    const agentResults: AgentResult[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        agentResults.push(result.value);
      } else {
        this.log("Agent 执行失败: %s", result.reason);
      }
    }

    // 汇总所有成功结果
    const combinedOutput = agentResults
      .map((r, i) => `[${this.agents[i]!.name}]: ${r.output}`)
      .join("\n\n");

    this.emit("orchestrator:end", { id: this.id, output: combinedOutput });

    return {
      output: combinedOutput,
      agentResults,
      metadata: {
        strategy: "parallel",
        totalAgents: this.agents.length,
        successCount: agentResults.length,
        failCount: results.filter((r) => r.status === "rejected").length,
      },
    };
  }
}

// ============ 路由编排器 ============

/**
 * RouterOrchestrator
 * 根据 route() 函数决定分发目标
 */
export class RouterOrchestrator extends BaseOrchestrator {
  private readonly routeFn: RouteFunction;

  constructor(def: OrchestratorDef) {
    super(def);
    if (!def.route) {
      throw new Error(`RouterOrchestrator "${def.id}" 必须提供 route 函数`);
    }
    this.routeFn = def.route;
  }

  async run(options: OrchestratorRunOptions): Promise<OrchestratorResult> {
    this.emit("orchestrator:start", { id: this.id, strategy: "router" });
    this.log("路由决策中...");

    // 调用路由函数决定目标 Agent
    const targets = await this.routeFn(options.input, this.agents);
    const targetList = Array.isArray(targets) ? targets : [targets];

    this.log("路由结果: %s", targetList.map((t) => t.name).join(", "));

    const agentResults: AgentResult[] = [];

    for (const agent of targetList) {
      if (options.abortSignal?.aborted) {
        break;
      }

      const context: AgentContext = {
        messages: [],
        metadata: { ...options.context, routedTo: agent.id },
        abortSignal: options.abortSignal,
      };

      const result = await this.executeAgent(agent, options.input, context);
      agentResults.push(result);
    }

    const finalOutput = agentResults
      .map((r) => r.output)
      .join("\n\n");

    this.emit("orchestrator:end", { id: this.id, output: finalOutput });

    return {
      output: finalOutput,
      agentResults,
      metadata: {
        strategy: "router",
        routedTo: targetList.map((t) => t.id),
      },
    };
  }
}

// ============ 监督者编排器 ============

/**
 * SupervisorOrchestrator
 * 一个 supervisor Agent 负责分配任务给 worker Agent
 */
export class SupervisorOrchestrator extends BaseOrchestrator {
  private readonly supervisor: AgentDef;

  constructor(def: OrchestratorDef, supervisor: AgentDef) {
    super(def);
    this.supervisor = supervisor;
  }

  async run(options: OrchestratorRunOptions): Promise<OrchestratorResult> {
    this.emit("orchestrator:start", { id: this.id, strategy: "supervisor" });
    this.log("Supervisor 开始分配任务...");

    // 第一步：让 supervisor 分析输入并制定任务分配计划
    const supervisorContext: AgentContext = {
      messages: [
        {
          id: `sys-${Date.now()}`,
          role: "system",
          type: "text",
          content: `你是一个任务分配者。可用的 worker Agent 列表：${this.agents.map((a) => `${a.name}(${a.id})`).join(", ")}。请根据输入分配任务。返回 JSON 格式：[{"agentId": "agent标识", "task": "具体任务"}]`,
          timestamp: Date.now(),
        },
      ],
      metadata: {
        ...options.context,
        availableAgents: this.agents.map((a) => a.id),
      },
      abortSignal: options.abortSignal,
    };

    const plan = await this.executeAgent(this.supervisor, options.input, supervisorContext);

    // 第二步：解析 supervisor 的分配计划并执行
    let assignments: Array<{ agentId: string; task: string }>;
    try {
      assignments = JSON.parse(plan.output) as Array<{ agentId: string; task: string }>;
    } catch {
      // 如果解析失败，将整个任务发给所有 worker
      this.log("Supervisor 输出解析失败，将任务发给所有 worker");
      assignments = this.agents.map((a) => ({ agentId: a.id, task: options.input }));
    }

    const agentResults: AgentResult[] = [plan];

    for (const assignment of assignments) {
      if (options.abortSignal?.aborted) {
        break;
      }

      const targetAgent = this.agents.find((a) => a.id === assignment.agentId);
      if (!targetAgent) {
        this.log("未找到 Agent: %s，跳过", assignment.agentId);
        continue;
      }

      const workerContext: AgentContext = {
        messages: [],
        metadata: { ...options.context, assignedBy: this.supervisor.id },
        abortSignal: options.abortSignal,
      };

      const result = await this.executeAgent(targetAgent, assignment.task, workerContext);
      agentResults.push(result);
    }

    // 汇总结果（跳过 supervisor 自身的结果）
    const workerResults = agentResults.slice(1);
    const finalOutput = workerResults
      .map((r) => r.output)
      .join("\n\n");

    this.emit("orchestrator:end", { id: this.id, output: finalOutput });

    return {
      output: finalOutput,
      agentResults,
      metadata: {
        strategy: "supervisor",
        supervisorId: this.supervisor.id,
        assignments,
      },
    };
  }
}

// ============ 工厂函数 ============

/** 创建编排器的配置选项 */
export interface CreateOrchestratorOptions {
  /** 编排器定义 */
  def: OrchestratorDef;
  /** supervisor 模式时的监督者 Agent */
  supervisor?: AgentDef;
}

/** 根据定义创建对应类型的编排器实例 */
export function createOrchestrator(options: CreateOrchestratorOptions): BaseOrchestrator {
  const { def, supervisor } = options;

  switch (def.strategy) {
    case "sequential":
      return new SequentialOrchestrator(def);
    case "parallel":
      return new ParallelOrchestrator(def);
    case "router":
      return new RouterOrchestrator(def);
    case "supervisor": {
      if (!supervisor) {
        throw new Error(`SupervisorOrchestrator "${def.id}" 必须提供 supervisor Agent`);
      }
      return new SupervisorOrchestrator(def, supervisor);
    }
    default:
      throw new Error(`不支持的编排策略: ${def.strategy}`);
  }
}
