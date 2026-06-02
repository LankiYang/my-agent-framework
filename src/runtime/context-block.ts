/**
 * ContentBlock 组合消息模式
 * 参考 AgentScope 的 ContentBlock 设计，实现结构化消息组合
 */

import type {
  Message,
  MessageRole,
  StreamEvent,
  ToolInput,
} from "../core/types.js";

// ============================================================
// ContentBlock 类型体系
// ============================================================

/** 文本块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 思考块（模型内部推理过程） */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/** 工具调用块 */
export interface ToolCallBlock {
  type: "tool_call";
  toolName: string;
  toolInput: ToolInput;
  toolCallId: string;
}

/** 工具结果块 */
export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError: boolean;
}

/** 数据块（图片、文件等多模态数据） */
export interface DataBlock {
  type: "data";
  mimeType: string;
  data: string;
}

/** ContentBlock 联合类型 */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | DataBlock;

// ============================================================
// Msg 类
// ============================================================

/**
 * Msg —— 基于 ContentBlock 数组的组合消息类
 *
 * 与基础 Message 不同，Msg 的 content 为结构化块数组，
 * 可同时包含文本、思考过程、工具调用及结果等多种类型内容。
 */
export class Msg {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: ContentBlock[];
  readonly timestamp: number;
  readonly metadata: Record<string, unknown>;

  constructor(
    role: MessageRole,
    content: ContentBlock[] = [],
    metadata: Record<string, unknown> = {},
  ) {
    this.id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.role = role;
    this.content = content;
    this.timestamp = Date.now();
    this.metadata = metadata;
  }

  /**
   * 创建纯文本消息
   * @param role 消息角色
   * @param text 文本内容
   */
  static ofText(role: MessageRole, text: string): Msg {
    const block: TextBlock = { type: "text", text };
    return new Msg(role, [block]);
  }

  /**
   * 创建工具调用消息
   * @param toolName 工具名称
   * @param input 工具输入参数
   * @param toolCallId 工具调用标识
   */
  static ofToolCall(toolName: string, input: ToolInput, toolCallId: string): Msg {
    const block: ToolCallBlock = {
      type: "tool_call",
      toolName,
      toolInput: input,
      toolCallId,
    };
    return new Msg("assistant", [block]);
  }

  /**
   * 创建工具结果消息
   * @param toolCallId 对应的工具调用标识
   * @param content 结果内容
   * @param isError 是否执行出错
   */
  static ofToolResult(toolCallId: string, content: string, isError: boolean = false): Msg {
    const block: ToolResultBlock = {
      type: "tool_result",
      toolCallId,
      content,
      isError,
    };
    return new Msg("tool", [block]);
  }

  /**
   * 实时应用 StreamEvent 到消息内容（流式渲染）
   *
   * - content_delta: 追加到最后一个 TextBlock，若无则新建
   * - tool_use: 追加新的 ToolCallBlock
   * - end_turn / error: 不做内容变更
   */
  appendEvent(event: StreamEvent): void {
    switch (event.type) {
      case "content_delta": {
        const lastBlock = this.content[this.content.length - 1];
        if (lastBlock?.type === "text") {
          (lastBlock as TextBlock).text += event.delta;
        } else {
          this.content.push({ type: "text", text: event.delta });
        }
        break;
      }

      case "tool_use": {
        this.content.push({
          type: "tool_call",
          toolName: event.toolName,
          toolInput: event.toolInput,
          toolCallId: event.toolCallId,
        });
        break;
      }

      case "end_turn":
      case "error":
        break;
    }
  }
}

// ============================================================
// 消息工具函数
// ============================================================

/**
 * 将 Msg 转为纯文本
 * 拼接消息中所有 TextBlock 的 text 内容
 */
export function msgToText(msg: Msg): string {
  return msg.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * 转为兼容现有 model 接口的 Message 格式
 *
 * 将 Msg 的 ContentBlock[] 序列化为扁平字符串，
 * 同时将原始 blocks 保存在 metadata 中以支持后续扩展使用。
 */
export function msgToAPIFormat(msg: Msg): Message {
  const textContent = msgToText(msg);

  // 检测是否包含工具调用块，决定 type
  const hasToolCall = msg.content.some((b) => b.type === "tool_call");
  const hasToolResult = msg.content.some((b) => b.type === "tool_result");

  let type: "text" | "tool_call" | "tool_result";
  if (hasToolCall) {
    type = "tool_call";
  } else if (hasToolResult) {
    type = "tool_result";
  } else {
    type = "text";
  }

  return {
    id: msg.id,
    role: msg.role,
    type,
    content: textContent,
    timestamp: msg.timestamp,
    metadata: {
      ...msg.metadata,
      blocks: msg.content,
    },
  } as Message;
}
