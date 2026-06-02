/**
 * Model Provider 模块
 * 提供模型调用的抽象基类和测试用 mock 实现
 */

import type {
  Message,
  ModelProvider,
  StreamEvent,
  ToolDef,
  ModelCallOptions,
  ModelCallResult,
} from "../../core/types.js";

// ============ 基础模型提供者抽象类 ============

/**
 * BaseModelProvider 抽象类
 * 实现 ModelProvider 接口，提供通用逻辑
 */
export abstract class BaseModelProvider implements ModelProvider {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  /** 子类需实现具体的流式生成逻辑 */
  abstract generate(
    messages: Message[],
    tools: ToolDef[],
    systemPrompt: string,
  ): AsyncGenerator<StreamEvent, void, unknown>;

  /** 验证消息格式 */
  protected validateMessages(messages: Message[]): void {
    if (!messages || messages.length === 0) {
      throw new Error("消息列表不能为空");
    }
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        throw new Error("消息必须包含 role 和 content 字段");
      }
    }
  }

  /** 计算输入 token 数（简易估算：按字符数 / 4） */
  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * 便捷方法：非流式调用（内部消费流式结果）
   * 提供给不需要流式的场景使用
   */
  async call(messages: Message[], options?: ModelCallOptions): Promise<ModelCallResult> {
    this.validateMessages(messages);

    const systemMsg = messages.find((m) => m.role === "system");
    const systemPrompt = systemMsg?.content ?? "";
    const tools = options?.tools ?? [];

    let content = "";
    const generator = this.generate(messages, tools, systemPrompt);

    for await (const event of generator) {
      if (event.type === "content_delta") {
        content += event.delta;
      }
    }

    const inputText = messages.map((m) => m.content).join("");
    return {
      content,
      finishReason: "stop",
      usage: {
        inputTokens: this.estimateTokens(inputText),
        outputTokens: this.estimateTokens(content),
      },
    };
  }
}

// ============ Echo Model Provider ============

/**
 * EchoModelProvider
 * 测试用 mock provider，直接回显输入
 */
export class EchoModelProvider extends BaseModelProvider {
  constructor(id = "echo") {
    super(id);
  }

  async *generate(
    messages: Message[],
    _tools: ToolDef[],
    _systemPrompt: string,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    this.validateMessages(messages);

    // 取最后一条用户消息作为回显内容
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const echoContent = lastUserMessage
      ? `[Echo] ${lastUserMessage.content}`
      : "[Echo] (无用户消息)";

    // 产出内容增量事件
    yield { type: "content_delta", delta: echoContent };

    // 产出结束事件
    yield { type: "end_turn", stopReason: "end_turn" };
  }
}
