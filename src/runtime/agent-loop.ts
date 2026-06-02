/**
 * Agent 推理循环实现
 *
 * 基于 Claude Code query.ts 的设计哲学完全重构：
 * - State Object + Continue Sites 模式：单个 LoopState 管理所有跨迭代可变状态
 * - 丰富的 Terminal 状态（10 种终止原因）
 * - 丰富的 Continue 原因（5 种继续原因）
 * - 消息预处理管道（token 裁剪 → 系统上下文附加 → 发送 API）
 * - 恢复策略（prompt_too_long / max_output_tokens / hook blocking）
 * - 依赖注入（AgentLoopDeps）支持可测试性
 * - 工具执行后的消息组装
 */

import type {
  Message,
  ModelProvider,
  ToolDef,
  StreamEvent,
  SharedContext,
  ToolCallMessage,
} from "../core/types.js";
import { ToolExecutor } from "./tool-executor.js";
import { ContextManager, CHARS_PER_TOKEN } from "./context-manager.js";
import { HookRegistry, HookPoint } from "./middleware.js";
import type { MiddlewareContext } from "./middleware.js";
import { PermissionEngine, PermissionMode } from "./permission.js";

// ============================================================
// Terminal 状态 — 10 种终止原因
// ============================================================

/** Agent 循环终止原因 */
export type StopReason =
  | "completed"          // 正常完成（模型无 tool_use）
  | "max_turns"          // 达到最大轮次
  | "aborted_streaming"  // 流式阶段中断
  | "aborted_tools"      // 工具执行阶段中断
  | "model_error"        // 模型调用异常
  | "prompt_too_long"    // 提示过长且无法恢复
  | "blocking_limit"     // 超出硬性上下文限制
  | "hook_prevented"     // Hook 阻止继续
  | "budget_exhausted"   // Token 预算耗尽
  | "permission_denied"; // 权限拒绝

// ============================================================
// Continue 原因 — 5 种继续原因
// ============================================================

/** Agent 循环继续原因 */
export type ContinueReason =
  | "next_turn"                    // 工具执行完成，继续下一轮
  | "max_output_recovery"          // 输出超限恢复
  | "prompt_too_long_recovery"     // 提示过长恢复（裁剪后重试）
  | "hook_blocking_retry"          // Hook blocking 后重试
  | "token_budget_continuation";   // Token 预算未耗尽

// ============================================================
// State 对象
// ============================================================

/** 循环内部状态：所有跨迭代的可变状态集中管理 */
interface LoopState {
  /** 当前消息列表 */
  messages: Message[];
  /** 已完成的轮次计数 */
  turnCount: number;
  /** max_output_tokens 恢复计数 */
  maxOutputRecoveryCount: number;
  /** 是否已尝试过压缩 */
  hasAttemptedCompact: boolean;
  /** 续传信息（上一次 continue 的原因） */
  transition: { reason: ContinueReason; detail?: unknown } | undefined;
}

// ============================================================
// 依赖注入接口
// ============================================================

/** 依赖注入：解耦模型调用、工具执行、上下文裁剪、Hook 应用 */
export interface AgentLoopDeps {
  /** 调用模型，返回流式事件 */
  callModel: (messages: Message[], tools: ToolDef[], systemPrompt: string) => AsyncGenerator<StreamEvent>;
  /** 批量执行工具调用 */
  executeTools: (calls: ToolCallMessage[], context: SharedContext, signal?: AbortSignal) => Promise<Message[]>;
  /** 按预算裁剪消息 */
  trimContext: (messages: Message[], budget: number) => Message[];
  /** 应用 Hook，返回可能被修改的上下文 */
  applyHooks: (point: HookPoint, context: MiddlewareContext) => Promise<MiddlewareContext>;
}

// ============================================================
// 选项
// ============================================================

/** Agent 循环配置选项 */
export interface AgentLoopOptions {
  /** 模型提供者 */
  model: ModelProvider;
  /** 可用工具列表 */
  tools: ToolDef[];
  /** 系统提示词 */
  systemPrompt: string;
  /** 最大轮次限制 */
  maxTurns?: number;
  /** 中断信号 */
  abortSignal?: AbortSignal;
  /** Token 预算（按字符估算） */
  tokenBudget?: number;
  /** max_output_tokens 恢复尝试次数上限 */
  maxOutputRecoveryLimit?: number;
  /** 部分或全部依赖注入（未提供的使用默认实现） */
  deps?: Partial<AgentLoopDeps>;
  /** Hook 注册中心 */
  hooks?: HookRegistry;
  /** 权限引擎（可选） */
  permissionEngine?: PermissionEngine;
  /** 权限模式（可选，默认 PermissionMode.Default） */
  permissionMode?: PermissionMode;
  /** 恢复重试退避延迟（毫秒，默认 1000） */
  recoveryBackoffMs?: number;
}

// ============================================================
// 事件类型
// ============================================================

/** Agent 循环产出的事件 */
export type AgentLoopEvent =
  | { type: "turn_start"; turn: number }
  | StreamEvent
  | { type: "tool_exec_start"; toolCallId: string; toolName: string }
  | { type: "tool_exec_end"; toolCallId: string; toolName: string; isError: boolean; durationMs: number }
  | { type: "turn_end"; reason: StopReason; turn: number }
  | { type: "recovery"; reason: ContinueReason; attempt?: number }
  | { type: "compact"; tokensBefore: number; tokensAfter: number };

// ============================================================
// 终止信息
// ============================================================

/** Agent 循环最终返回的终止信息 */
export interface AgentLoopTerminal {
  /** 终止原因 */
  reason: StopReason;
  /** 总轮次数 */
  turnCount: number;
  /** 最终消息列表 */
  messages: Message[];
  /** 最后一次续传信息（调试用） */
  transition?: { reason: ContinueReason; detail?: unknown };
}

// ============================================================
// 常量
// ============================================================

/** 默认最大轮次 */
const DEFAULT_MAX_TURNS = 50;

/** 默认 max_output 恢复次数上限 */
const DEFAULT_MAX_OUTPUT_RECOVERY_LIMIT = 3;

/** 硬性上下文 token 限制 */
const BLOCKING_TOKEN_LIMIT = 250_000;

/** 默认恢复重试退避延迟（毫秒） */
const DEFAULT_RECOVERY_BACKOFF_MS = 1000;

/** 延迟指定毫秒 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 构建默认的依赖实现
 * 当用户未注入某项依赖时，使用框架内置的 ToolExecutor / ContextManager / HookRegistry
 */
function buildDefaultDeps(options: AgentLoopOptions): AgentLoopDeps {
  const { model, tools, hooks, permissionEngine, permissionMode } = options;
  const toolExecutor = new ToolExecutor(tools, permissionEngine, permissionMode);
  const contextManager = new ContextManager();
  const hookRegistry = hooks ?? new HookRegistry();

  return {
    callModel(messages, toolDefs, systemPrompt) {
      return model.generate(messages, toolDefs, systemPrompt);
    },

    async executeTools(calls, context, signal) {
      return toolExecutor.executeMany(calls, context, signal);
    },

    trimContext(messages, budget) {
      return contextManager.trimToTokenBudget(messages, budget);
    },

    async applyHooks(point, context) {
      await hookRegistry.apply(point, context);
      return context;
    },
  };
}

/**
 * 合并用户注入的 deps 与默认 deps
 */
function resolveDeps(options: AgentLoopOptions): AgentLoopDeps {
  const defaults = buildDefaultDeps(options);
  const userDeps = options.deps ?? {};
  return {
    callModel: userDeps.callModel ?? defaults.callModel,
    executeTools: userDeps.executeTools ?? defaults.executeTools,
    trimContext: userDeps.trimContext ?? defaults.trimContext,
    applyHooks: userDeps.applyHooks ?? defaults.applyHooks,
  };
}

/**
 * 估算消息列表的总 token 数（与 ContextManager 使用相同的 CHARS_PER_TOKEN 比率）
 */
function estimateTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += msg.content.length + msg.role.length;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * 创建 MiddlewareContext 用于 Hook 调用
 */
function createHookContext(
  messages: Message[],
  systemPrompt: string,
  tools: ToolDef[],
  agentId: string,
): MiddlewareContext {
  return {
    messages,
    systemPrompt,
    tools,
    agentId,
  };
}

// ============================================================
// 核心循环
// ============================================================

/**
 * Agent 推理循环 —— 核心 async generator
 *
 * 设计模式：State Object + Continue Sites
 * - 所有跨迭代的可变状态集中在 LoopState 对象中
 * - 每个"续传点"通过 `state = newState; continue;` 实现跳转
 * - 终止时 return AgentLoopTerminal
 *
 * 消息预处理管道：
 *   原始消息 → token 裁剪 → blocking limit 检查 → 发送给模型
 *
 * 恢复策略：
 *   1. prompt_too_long：压缩消息后重试（仅一次）
 *   2. max_output_tokens：追加续写提示后重试（最多 N 次）
 *   3. hook blocking：追加 hook 拒绝消息后重试
 */
export async function* agentLoop(
  messages: Message[],
  options: AgentLoopOptions,
): AsyncGenerator<AgentLoopEvent, AgentLoopTerminal> {
  const {
    tools,
    systemPrompt,
    maxTurns = DEFAULT_MAX_TURNS,
    abortSignal,
    tokenBudget,
    maxOutputRecoveryLimit = DEFAULT_MAX_OUTPUT_RECOVERY_LIMIT,
    recoveryBackoffMs = DEFAULT_RECOVERY_BACKOFF_MS,
  } = options;

  // 解析依赖
  const deps = resolveDeps(options);

  // 初始化循环状态
  let state: LoopState = {
    messages: [...messages],
    turnCount: 0,
    maxOutputRecoveryCount: 0,
    hasAttemptedCompact: false,
    transition: undefined,
  };

  // === 主循环 ===
  while (true) {
    // ----------------------------------------------------------
    // 1. 检查外部中断
    // ----------------------------------------------------------
    if (abortSignal?.aborted) {
      yield { type: "turn_end", reason: "aborted_streaming", turn: state.turnCount };
      return {
        reason: "aborted_streaming",
        turnCount: state.turnCount,
        messages: state.messages,
        transition: state.transition,
      };
    }

    // ----------------------------------------------------------
    // 2. 轮次计数 + 检查最大轮次
    // ----------------------------------------------------------
    state.turnCount++;
    if (state.turnCount > maxTurns) {
      yield { type: "turn_end", reason: "max_turns", turn: state.turnCount - 1 };
      return {
        reason: "max_turns",
        turnCount: state.turnCount - 1,
        messages: state.messages,
        transition: state.transition,
      };
    }

    // ----------------------------------------------------------
    // 3. 如果是恢复续传，产出 recovery 事件
    // ----------------------------------------------------------
    if (state.transition) {
      yield {
        type: "recovery",
        reason: state.transition.reason,
        attempt: state.transition.reason === "max_output_recovery"
          ? state.maxOutputRecoveryCount
          : undefined,
      };
    }

    // ----------------------------------------------------------
    // 4. 产出 turn_start 事件
    // ----------------------------------------------------------
    yield { type: "turn_start", turn: state.turnCount };

    // ----------------------------------------------------------
    // 5. 消息预处理管道
    // ----------------------------------------------------------
    let messagesForModel = [...state.messages];

    // 5a. Token 预算裁剪
    if (tokenBudget) {
      const tokensBefore = estimateTokens(messagesForModel);
      messagesForModel = deps.trimContext(messagesForModel, tokenBudget);
      const tokensAfter = estimateTokens(messagesForModel);

      // 如果发生了裁剪，产出 compact 事件
      if (tokensAfter < tokensBefore) {
        yield { type: "compact", tokensBefore, tokensAfter };
      }
    }

    // 5b. Blocking limit 检查（硬性上下文限制）
    if (estimateTokens(messagesForModel) > BLOCKING_TOKEN_LIMIT) {
      yield { type: "turn_end", reason: "blocking_limit", turn: state.turnCount };
      return {
        reason: "blocking_limit",
        turnCount: state.turnCount,
        messages: state.messages,
        transition: state.transition,
      };
    }

    // 5c. Token 预算耗尽检查（裁剪后消息为空）
    if (tokenBudget && messagesForModel.length === 0) {
      yield { type: "turn_end", reason: "budget_exhausted", turn: state.turnCount };
      return {
        reason: "budget_exhausted",
        turnCount: state.turnCount,
        messages: state.messages,
        transition: state.transition,
      };
    }

    // ----------------------------------------------------------
    // 6. 调用模型（流式）
    // ----------------------------------------------------------
    let assistantContent = "";
    const pendingToolCalls: ToolCallMessage[] = [];
    let stopReason = "";
    let modelError: Error | undefined;

    try {
      const stream = deps.callModel(messagesForModel, tools, systemPrompt);

      for await (const event of stream) {
        // 流式阶段中断检查
        if (abortSignal?.aborted) {
          yield { type: "turn_end", reason: "aborted_streaming", turn: state.turnCount };
          return {
            reason: "aborted_streaming",
            turnCount: state.turnCount,
            messages: state.messages,
            transition: state.transition,
          };
        }

        // 转发流事件
        yield event;

        // 累积状态
        switch (event.type) {
          case "content_delta":
            assistantContent += event.delta;
            break;

          case "tool_use":
            pendingToolCalls.push({
              id: `tc_${state.turnCount}_${pendingToolCalls.length}`,
              role: "assistant",
              type: "tool_call",
              content: "",
              timestamp: Date.now(),
              toolName: event.toolName,
              toolInput: event.toolInput,
              toolCallId: event.toolCallId,
            });
            break;

          case "end_turn":
            stopReason = event.stopReason;
            break;

          case "error":
            modelError = event.error;
            break;
        }
      }
    } catch (err) {
      modelError = err instanceof Error ? err : new Error(String(err));
    }

    // ----------------------------------------------------------
    // 7. 模型调用异常处理
    // ----------------------------------------------------------
    if (modelError) {
      yield { type: "turn_end", reason: "model_error", turn: state.turnCount };
      return {
        reason: "model_error",
        turnCount: state.turnCount,
        messages: state.messages,
        transition: state.transition,
      };
    }

    // ----------------------------------------------------------
    // 8. 将 assistant 回复追加到消息
    // ----------------------------------------------------------
    const assistantMessage: Message = {
      id: `msg_assistant_${state.turnCount}`,
      role: "assistant",
      type: "text",
      content: assistantContent,
      timestamp: Date.now(),
      metadata: {
        stopReason,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      },
    };

    // ----------------------------------------------------------
    // 9. 无工具调用 → 检查恢复策略或正常完成
    // ----------------------------------------------------------
    if (pendingToolCalls.length === 0) {
      // 9a. prompt_too_long 恢复
      const isPromptTooLong = stopReason === "prompt_too_long";
      if (isPromptTooLong && !state.hasAttemptedCompact) {
        // 尝试压缩后重试
        const compactedMessages = deps.trimContext(
          state.messages,
          tokenBudget ?? Math.floor(BLOCKING_TOKEN_LIMIT / 8),
        );

        state = {
          messages: compactedMessages,
          turnCount: state.turnCount,
          maxOutputRecoveryCount: state.maxOutputRecoveryCount,
          hasAttemptedCompact: true,
          transition: { reason: "prompt_too_long_recovery" },
        };
        continue;
      }

      // 如果压缩后仍然 prompt_too_long，终止
      if (isPromptTooLong && state.hasAttemptedCompact) {
        yield { type: "turn_end", reason: "prompt_too_long", turn: state.turnCount };
        return {
          reason: "prompt_too_long",
          turnCount: state.turnCount,
          messages: state.messages,
          transition: state.transition,
        };
      }

      // 9b. max_output_tokens 恢复
      const isMaxOutput = stopReason === "max_output_tokens" || stopReason === "length";
      if (isMaxOutput && state.maxOutputRecoveryCount < maxOutputRecoveryLimit) {
        // 追加续写提示消息
        const recoveryMessage: Message = {
          id: `recovery_${state.turnCount}_${state.maxOutputRecoveryCount}`,
          role: "user",
          type: "text",
          content: "请继续你之前的输出，从你被截断的地方继续。",
          timestamp: Date.now(),
        };

        state = {
          messages: [...state.messages, assistantMessage, recoveryMessage],
          turnCount: state.turnCount,
          maxOutputRecoveryCount: state.maxOutputRecoveryCount + 1,
          hasAttemptedCompact: state.hasAttemptedCompact,
          transition: { reason: "max_output_recovery" },
        };
        await delay(recoveryBackoffMs);
        continue;
      }

      // 9c. Hook 检查（onReply）
      const hookCtx = createHookContext(
        [...state.messages, assistantMessage],
        systemPrompt,
        tools,
        `agent_loop_${state.turnCount}`,
      );
      const hookResult = await deps.applyHooks(HookPoint.onReply, hookCtx);

      // 检测 hook 是否设置了 blocked 标志
      if (hookResult["blocked"] === true) {
        const blockReason = (hookResult["blockReason"] as string) ?? "Hook 阻止了回复";
        const blockingMessage: Message = {
          id: `hook_block_${state.turnCount}`,
          role: "system",
          type: "text",
          content: `[Hook Blocked] ${blockReason}`,
          timestamp: Date.now(),
        };

        state = {
          messages: [...state.messages, assistantMessage, blockingMessage],
          turnCount: state.turnCount,
          maxOutputRecoveryCount: state.maxOutputRecoveryCount,
          hasAttemptedCompact: state.hasAttemptedCompact,
          transition: { reason: "hook_blocking_retry", detail: blockReason },
        };
        await delay(recoveryBackoffMs);
        continue;
      }

      // 9d. 正常完成
      const finalMessages = [...state.messages, assistantMessage];
      yield { type: "turn_end", reason: "completed", turn: state.turnCount };
      return {
        reason: "completed",
        turnCount: state.turnCount,
        messages: finalMessages,
        transition: state.transition,
      };
    }

    // ----------------------------------------------------------
    // 10. 有工具调用 — 执行工具
    // ----------------------------------------------------------

    // 10a. 工具执行前检查中断
    if (abortSignal?.aborted) {
      yield { type: "turn_end", reason: "aborted_tools", turn: state.turnCount };
      return {
        reason: "aborted_tools",
        turnCount: state.turnCount,
        messages: state.messages,
        transition: state.transition,
      };
    }

    // 10b. 产出 tool_exec_start 事件
    for (const call of pendingToolCalls) {
      yield {
        type: "tool_exec_start",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      };
    }

    // 10c. 构建共享上下文
    const sharedContext: SharedContext = {
      messages: state.messages,
      artifacts: {},
      metadata: {},
    };

    // 10d. 执行工具
    const toolResults = await deps.executeTools(pendingToolCalls, sharedContext, abortSignal);

    // 10e. 执行后检查中断
    if (abortSignal?.aborted) {
      yield { type: "turn_end", reason: "aborted_tools", turn: state.turnCount };
      return {
        reason: "aborted_tools",
        turnCount: state.turnCount,
        messages: state.messages,
        transition: state.transition,
      };
    }

    // 10f. 产出 tool_exec_end 事件
    for (const result of toolResults) {
      yield {
        type: "tool_exec_end",
        toolCallId: result.id,
        toolName: (result.metadata?.["toolName"] as string) ?? "unknown",
        isError: result.type === "tool_result" && ((result.metadata?.["isError"] as boolean) ?? false),
        durationMs: (result.metadata?.["durationMs"] as number) ?? 0,
      };
    }

    // 10g. 权限拒绝检查：如果所有工具都因权限被拒绝
    const allPermissionDenied = toolResults.length > 0 && toolResults.every(
      (r) => r.content.includes("权限拒绝"),
    );
    if (allPermissionDenied) {
      const finalMsgs = [...state.messages, assistantMessage, ...toolResults];
      yield { type: "turn_end", reason: "permission_denied", turn: state.turnCount };
      return {
        reason: "permission_denied",
        turnCount: state.turnCount,
        messages: finalMsgs,
        transition: state.transition,
      };
    }

    // ----------------------------------------------------------
    // 11. 组装下一轮消息 — Continue Site: next_turn
    // ----------------------------------------------------------
    state = {
      messages: [...state.messages, assistantMessage, ...toolResults],
      turnCount: state.turnCount,
      maxOutputRecoveryCount: 0,
      hasAttemptedCompact: false,
      transition: { reason: "next_turn" },
    };
    continue;
  }
}
