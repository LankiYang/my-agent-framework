/**
 * 工具执行器
 * 参考 Claude Code 的 toolOrchestration.ts 设计
 * 负责工具的验证、权限检查、执行以及并发控制
 */

import type {
  Message,
  ToolCallMessage,
  ToolDef,
  ToolInput,
  ToolOutput,
  ToolResultMessage,
  SharedContext,
} from "../core/types.js";
import { PermissionEngine, PermissionMode, PermissionLevel } from "./permission.js";

// ============================================================
// 错误类型
// ============================================================

/** 工具执行错误 */
export class ToolExecutionError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly callId: string,
    cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`工具 "${toolName}" 执行失败: ${msg}`);
    this.name = "ToolExecutionError";
  }
}

/** 工具超时错误 */
export class ToolTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`工具 "${toolName}" 执行超时 (${timeoutMs}ms)`);
    this.name = "ToolTimeoutError";
  }
}

/** 默认超时时间 (ms) */
const DEFAULT_TIMEOUT_MS = 30_000;

// ============================================================
// 工具执行器
// ============================================================

/**
 * 工具执行器类
 *
 * 功能：
 * - executeMany: 根据 isConcurrencySafe 判断是否并行执行
 * - executeSingle: validateInput → checkPermissions → execute
 * - 超时保护
 * - 错误包装
 */
export class ToolExecutor {
  /** 工具名称到定义的映射 */
  private readonly toolMap: Map<string, ToolDef>;
  private readonly permissionEngine?: PermissionEngine;
  private readonly permissionMode: PermissionMode;
  private readonly askHandler?: (toolName: string, input: ToolInput) => Promise<boolean>;

  constructor(
    tools: ToolDef[],
    permissionEngine?: PermissionEngine,
    permissionMode?: PermissionMode,
    askHandler?: (toolName: string, input: ToolInput) => Promise<boolean>,
  ) {
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
    this.permissionEngine = permissionEngine;
    this.permissionMode = permissionMode ?? PermissionMode.Default;
    this.askHandler = askHandler;
  }

  /** 获取所有已注册的工具定义 */
  getAllTools(): ToolDef[] {
    return Array.from(this.toolMap.values());
  }

  /**
   * 批量执行工具调用
   * 根据工具是否并发安全来决定执行策略：
   * - 并发安全的工具并行执行
   * - 非并发安全的工具串行执行
   */
  async executeMany(
    calls: ToolCallMessage[],
    context: SharedContext,
    abortSignal?: AbortSignal,
  ): Promise<Message[]> {
    if (calls.length === 0) {
      return [];
    }

    // 将调用分为并发安全组和串行组
    const { concurrent, serial } = this.partitionCalls(calls);
    const results: Message[] = [];

    // 并发安全的工具并行执行
    if (concurrent.length > 0) {
      const concurrentResults = await Promise.all(
        concurrent.map((call) => this.executeSingle(call, context, abortSignal)),
      );
      results.push(...concurrentResults);
    }

    // 非并发安全的工具串行执行
    for (let i = 0; i < serial.length; i++) {
      const call = serial[i]!;
      // 每次执行前检查中断：为当前及剩余所有工具补 aborted 占位结果，
      // 保证返回列表与输入 calls 一一对应（每个 tool_call 都有响应）
      if (abortSignal?.aborted) {
        for (let j = i; j < serial.length; j++) {
          results.push(this.createErrorResult(serial[j]!, "执行被中断"));
        }
        break;
      }
      const result = await this.executeSingle(call, context, abortSignal);
      results.push(result);
    }

    return results;
  }

  /**
   * 执行单个工具调用
   * 流程：validateInput → checkPermissions → execute（含超时保护）
   */
  async executeSingle(
    call: ToolCallMessage,
    context: SharedContext,
    abortSignal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const startTime = Date.now();

    // 查找工具定义
    const toolDef = this.toolMap.get(call.toolName);
    if (!toolDef) {
      return this.createErrorResult(call, `未找到工具 "${call.toolName}"`);
    }

    // 输入验证
    const validationError = this.validateInput(call.toolInput, toolDef);
    if (validationError) {
      return this.createErrorResult(call, validationError);
    }

    // 权限检查
    const permissionDenied = await this.checkPermissions(toolDef, call.toolInput, context);
    if (permissionDenied) {
      return this.createErrorResult(call, permissionDenied);
    }

    // 执行工具（含超时保护）
    try {
      const output = await this.executeWithTimeout(
        toolDef,
        call.toolInput,
        context,
        toolDef.timeout ?? DEFAULT_TIMEOUT_MS,
      );
      const durationMs = Date.now() - startTime;

      return {
        id: `result_${call.toolCallId}`,
        role: "tool",
        type: "tool_result",
        content: output.content,
        timestamp: Date.now(),
        toolCallId: call.toolCallId,
        toolOutput: output,
        isError: false,
        metadata: {
          toolName: call.toolName,
          durationMs,
          isError: false,
        },
      };
    } catch (err) {
      // 错误包装
      const durationMs = Date.now() - startTime;
      const wrappedError = new ToolExecutionError(
        call.toolName,
        call.toolCallId,
        err,
      );

      return {
        id: `result_${call.toolCallId}`,
        role: "tool",
        type: "tool_result",
        content: wrappedError.message,
        timestamp: Date.now(),
        toolCallId: call.toolCallId,
        toolOutput: { content: wrappedError.message },
        isError: true,
        metadata: {
          toolName: call.toolName,
          durationMs,
          isError: true,
        },
      };
    }
  }

  /**
   * 验证工具调用的输入参数
   * 优先使用工具自身的 validateInput 方法
   */
  private validateInput(input: ToolInput, toolDef: ToolDef): string | null {
    if (toolDef.validateInput) {
      const result = toolDef.validateInput(input);
      if (!result.valid) {
        return `输入验证失败: ${result.error ?? "未知错误"}`;
      }
    }
    return null;
  }

  /**
   * 检查工具执行权限
   * 优先使用 PermissionEngine，否则回退到工具自身的 checkPermissions
   */
  private async checkPermissions(
    toolDef: ToolDef,
    input: ToolInput,
    context: SharedContext,
  ): Promise<string | null> {
    if (this.permissionEngine) {
      const level = this.permissionEngine.checkToolPermission(
        toolDef.name,
        input,
        this.getAllTools(),
        this.permissionMode,
      );
      if (level === PermissionLevel.Denied) {
        return `权限拒绝: 工具 "${toolDef.name}" 未被授权执行`;
      }
      if (level === PermissionLevel.Ask) {
        // Ask：交给 askHandler 决定；无 handler 时安全默认为拒绝
        if (!this.askHandler) {
          return `权限拒绝: 工具 "${toolDef.name}" 需要确认，但未提供 askHandler`;
        }
        const approved = await this.askHandler(toolDef.name, input);
        if (!approved) {
          return `权限拒绝: 工具 "${toolDef.name}" 的执行请求被拒绝`;
        }
        return null;
      }
      if (level === PermissionLevel.Allowed || level === PermissionLevel.Bypass) {
        return null;
      }
    }

    if (toolDef.checkPermissions) {
      const allowed = await toolDef.checkPermissions(context);
      if (!allowed) {
        return `权限拒绝: 工具 "${toolDef.name}" 未被授权执行`;
      }
    }
    return null;
  }

  /**
   * 带超时保护地执行工具
   * 使用 Promise.race 实现超时控制
   */
  private async executeWithTimeout(
    toolDef: ToolDef,
    input: ToolInput,
    context: SharedContext,
    timeoutMs: number,
  ): Promise<ToolOutput> {
    let timerId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<ToolOutput>((resolve, reject) => {
        timerId = setTimeout(() => {
          reject(new ToolTimeoutError(toolDef.name, timeoutMs));
        }, timeoutMs);

        toolDef.execute(input, context).then(resolve, reject);
      });
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  /**
   * 将工具调用分为并发安全组和串行组
   * 判断依据：ToolDef.isConcurrencySafe 字段
   */
  private partitionCalls(calls: ToolCallMessage[]): {
    concurrent: ToolCallMessage[];
    serial: ToolCallMessage[];
  } {
    const concurrent: ToolCallMessage[] = [];
    const serial: ToolCallMessage[] = [];

    for (const call of calls) {
      const toolDef = this.toolMap.get(call.toolName);
      if (toolDef?.isConcurrencySafe) {
        concurrent.push(call);
      } else {
        serial.push(call);
      }
    }

    return { concurrent, serial };
  }

  /**
   * 创建错误结果消息
   */
  private createErrorResult(call: ToolCallMessage, errorMsg: string): ToolResultMessage {
    return {
      id: `result_${call.toolCallId}`,
      role: "tool",
      type: "tool_result",
      content: errorMsg,
      timestamp: Date.now(),
      toolCallId: call.toolCallId,
      toolOutput: { content: errorMsg },
      isError: true,
      metadata: {
        toolName: call.toolName,
        durationMs: 0,
        isError: true,
      },
    };
  }
}
