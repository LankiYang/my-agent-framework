/**
 * 上下文管理器
 * 负责消息构建、系统上下文附加、token 预算裁剪、工具描述生成
 */

import type {
  Message,
  ToolDef,
  Session,
} from "../core/types.js";

// ============================================================
// 常量
// ============================================================

/** 每个字符估算的 token 数（简单的字符估算比率） */
export const CHARS_PER_TOKEN = 4;

// ============================================================
// 上下文管理器
// ============================================================

/**
 * 上下文管理器类
 *
 * 职责：
 * - buildMessages: 根据 Session 构建发送给模型的消息列表
 * - appendSystemContext: 向消息列表附加系统上下文信息
 * - trimToTokenBudget: 按字符估算进行 token 预算裁剪
 * - getToolDescriptions: 生成工具描述文本供模型参考
 */
export class ContextManager {
  /**
   * 根据 Session 构建发送给模型的完整消息列表
   * 按照 [system, ...历史消息] 的顺序组装
   */
  buildMessages(session: Session): Message[] {
    const messages: Message[] = [];

    // 如果有系统提示词，作为第一条 system 消息
    if (session.systemPrompt) {
      messages.push({
        id: `sys_${session.id}`,
        role: "system",
        type: "text",
        content: session.systemPrompt,
        timestamp: Date.now(),
      });
    }

    // 附加会话中的所有历史消息
    messages.push(...session.messages);

    // 附加系统上下文（如时间、环境等）
    this.appendSystemContext(messages);

    return messages;
  }

  /**
   * 向消息列表末尾附加系统上下文信息
   * 包含当前时间戳、环境标识等运行时信息
   */
  appendSystemContext(messages: Message[]): void {
    const contextParts: string[] = [];

    // 附加当前时间
    contextParts.push(`当前时间: ${new Date().toISOString()}`);

    // 附加运行环境标识
    contextParts.push(`运行环境: agent-framework/runtime`);

    if (contextParts.length > 0) {
      const lastMessage = messages[messages.length - 1];

      // 如果最后一条是 system 消息，合并内容；否则追加新的 system 消息
      if (lastMessage && lastMessage.role === "system") {
        lastMessage.content += "\n\n" + contextParts.join("\n");
      } else {
        messages.push({
          id: `ctx_${Date.now()}`,
          role: "system",
          type: "text",
          content: contextParts.join("\n"),
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * 根据 token 预算裁剪消息列表
   * 使用简单的字符数 / CHARS_PER_TOKEN 来估算 token 数
   *
   * 裁剪策略：
   * 1. 保留第一条 system 消息（如果有）
   * 2. 从最早的对话消息开始删除，保持 tool_call/tool_result 配对完整
   */
  trimToTokenBudget(messages: Message[], budget: number): Message[] {
    const totalTokens = this.estimateTokens(messages);

    // 未超预算，直接返回
    if (totalTokens <= budget) {
      return messages;
    }

    // 确保至少保留第一条和最后一条
    if (messages.length <= 2) {
      return messages;
    }

    // 分离系统消息和对话消息
    const systemMessages: Message[] = [];
    const conversationMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === "system" && systemMessages.length === 0) {
        systemMessages.push(msg);
      } else {
        conversationMessages.push(msg);
      }
    }

    // 从最早的对话消息开始删除，保持配对完整
    const trimmed = [...conversationMessages];
    let currentTokens = this.estimateTokens([...systemMessages, ...trimmed]);

    while (currentTokens > budget && trimmed.length > 1) {
      const remaining = this.removeEarliestPair(trimmed);
      if (remaining.length === trimmed.length) {
        break; // 无法继续裁剪
      }
      trimmed.length = 0;
      trimmed.push(...remaining);
      currentTokens = this.estimateTokens([...systemMessages, ...trimmed]);
    }

    return [...systemMessages, ...trimmed];
  }

  /**
   * 移除消息列表最早的一条（或一组配对的）消息
   * 保持 tool_call/tool_result 配对完整性
   */
  private removeEarliestPair(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;

    const first = messages[0];

    // Case A: tool_call 消息 → 找到对应 tool_result，一起移除
    if (first.role === "assistant" && first.type === "tool_call") {
      const callId = (first as any).toolCallId;
      const resultIdx = messages.findIndex(
        (m, i) => i > 0 && m.role === "tool" && m.type === "tool_result" && (m as any).toolCallId === callId,
      );
      if (resultIdx >= 0) {
        // 移除 tool_call 和 tool_result
        return messages.filter((_, i) => i !== 0 && i !== resultIdx);
      }
      // 无对应 result，单独移除 tool_call
      return messages.slice(1);
    }

    // Case B: tool_result 消息（孤立的） → 单独移除
    if (first.role === "tool" && first.type === "tool_result") {
      return messages.slice(1);
    }

    // Case C: assistant 文本消息含 metadata.toolCalls → 移除该消息及所有对应 tool_result
    if (
      first.role === "assistant" &&
      first.type === "text" &&
      first.metadata &&
      Array.isArray(first.metadata.toolCalls)
    ) {
      const callIds = new Set(
        (first.metadata.toolCalls as Array<{ toolCallId?: string }>).map((tc) => tc.toolCallId).filter(Boolean),
      );
      if (callIds.size > 0) {
        return messages.filter((m, i) => {
          if (i === 0) return false; // 移除该 assistant 消息
          if (m.role === "tool" && m.type === "tool_result" && callIds.has((m as any).toolCallId)) {
            return false; // 移除对应的 tool_result
          }
          return true;
        });
      }
    }

    // Case D: 普通消息（user/assistant text/system）→ 单独移除
    return messages.slice(1);
  }

  /**
   * 根据工具定义列表生成工具描述文本
   * 格式适合作为系统提示词的一部分注入给模型
   */
  getToolDescriptions(tools: ToolDef[]): string {
    if (tools.length === 0) {
      return "";
    }

    const descriptions = tools.map((tool) => {
      let desc = `### ${tool.name}\n`;
      desc += `${tool.description}\n`;

      // 从 inputSchema 中提取参数信息
      const schema = tool.inputSchema;
      if (schema && typeof schema === "object" && "properties" in schema) {
        const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
        const required = (schema.required as string[]) ?? [];

        if (properties) {
          desc += `\n参数:\n`;
          for (const [paramName, paramSchema] of Object.entries(properties)) {
            const isRequired = required.includes(paramName) ? " (必填)" : " (可选)";
            const paramDesc = (paramSchema.description as string) ?? "无描述";
            desc += `- ${paramName}${isRequired}: ${paramDesc}\n`;
          }
        }
      }

      return desc;
    });

    return `## 可用工具\n\n${descriptions.join("\n")}`;
  }

  /**
   * 估算消息列表的 token 总数
   * 使用简单的字符数除以固定比率来估算
   */
  private estimateTokens(messages: Message[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
      totalChars += msg.role.length;
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }
}
