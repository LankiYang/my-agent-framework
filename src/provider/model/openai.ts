/**
 * OpenAI Model Provider
 *
 * 通过 openai SDK 接入真实 OpenAI（或兼容 API）模型，实现 ModelProvider 的流式 generate()。
 * SDK 为可选依赖：动态 import 加载，未安装时抛出清晰错误。
 *
 * 消息转换：
 * - system → { role: "system" }
 * - 框架 tool_call（role=assistant, type=tool_call）→ assistant 消息的 tool_calls 字段
 * - 框架 tool_result（role=tool）→ { role: "tool", tool_call_id, content }
 * - OpenAI 的 tool_calls 参数是分片流式的，需按 index 缓冲拼接 JSON
 */

import { BaseModelProvider } from "./index.js";
import type {
  Message,
  StreamEvent,
  ToolDef,
  ToolCallMessage,
  ToolResultMessage,
} from "../../core/types.js";

/** OpenAI Provider 配置 */
export interface OpenAIProviderConfig {
  /** API Key，默认取 process.env.OPENAI_API_KEY */
  apiKey?: string;
  /** 模型名，默认 gpt-4o */
  model?: string;
  /** 自定义 baseURL（兼容 API / 代理） */
  baseURL?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export class OpenAIModelProvider extends BaseModelProvider {
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly baseURL?: string;
  private client: unknown;

  constructor(config: OpenAIProviderConfig = {}) {
    const modelName = config.model ?? "gpt-4o";
    super(`openai-${modelName}`);
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.modelName = modelName;
    this.baseURL = config.baseURL;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new Error("OpenAIModelProvider: 缺少 API Key（设置 OPENAI_API_KEY 或传入 apiKey）");
    }
    let OpenAI: any;
    try {
      ({ default: OpenAI } = await import("openai"));
    } catch {
      throw new Error("OpenAIModelProvider: 未安装 openai，请运行 `npm install openai`");
    }
    this.client = new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
    return this.client;
  }

  /** 把框架 Message[] 转成 OpenAI messages */
  private toOpenAIMessages(messages: Message[], systemPrompt: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    if (systemPrompt) {
      result.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === "system") {
        result.push({ role: "system", content: msg.content });
        continue;
      }

      // tool_result → role=tool
      if (msg.role === "tool" && msg.type === "tool_result") {
        const tr = msg as ToolResultMessage;
        result.push({
          role: "tool",
          tool_call_id: tr.toolCallId,
          content: tr.content,
        });
        continue;
      }

      // assistant tool_call → 合并进上一条 assistant 的 tool_calls
      if (msg.role === "assistant" && msg.type === "tool_call") {
        const tc = msg as ToolCallMessage;
        const call: OpenAIToolCall = {
          id: tc.toolCallId,
          type: "function",
          function: {
            name: tc.toolName,
            arguments: JSON.stringify(tc.toolInput ?? {}),
          },
        };
        const last = result[result.length - 1];
        if (last && last.role === "assistant" && last.tool_calls) {
          last.tool_calls.push(call);
        } else {
          result.push({ role: "assistant", content: null, tool_calls: [call] });
        }
        continue;
      }

      // 普通文本
      if (!msg.content) continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      result.push({ role, content: msg.content });
    }

    return result;
  }

  private toOpenAITools(tools: ToolDef[]): Array<Record<string, unknown>> {
    return tools.map((t) => {
      const schema = (t.inputSchema && typeof t.inputSchema === "object" && "type" in t.inputSchema)
        ? t.inputSchema
        : { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: schema,
        },
      };
    });
  }

  async *generate(
    messages: Message[],
    tools: ToolDef[],
    systemPrompt: string,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    let client: any;
    try {
      client = await this.getClient();
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }

    const openaiMessages = this.toOpenAIMessages(messages, systemPrompt);
    const openaiTools = this.toOpenAITools(tools);

    // 按 index 缓冲 tool_call 分片
    const toolAccum = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = "stop";

    try {
      const stream = await client.chat.completions.create({
        model: this.modelName,
        messages: openaiMessages,
        ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
        stream: true,
      });

      for await (const chunk of stream as AsyncIterable<any>) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta?.content) {
          yield { type: "content_delta", delta: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index ?? 0;
            let acc = toolAccum.get(idx);
            if (!acc) {
              acc = { id: tcDelta.id ?? "", name: "", args: "" };
              toolAccum.set(idx, acc);
            }
            if (tcDelta.id) acc.id = tcDelta.id;
            if (tcDelta.function?.name) acc.name = tcDelta.function.name;
            if (tcDelta.function?.arguments) acc.args += tcDelta.function.arguments;
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }

    // 流结束后，产出所有累积的 tool_use 事件
    for (const acc of toolAccum.values()) {
      let input: Record<string, unknown> = {};
      try {
        input = acc.args ? JSON.parse(acc.args) : {};
      } catch {
        console.warn(
          `[OpenAIModelProvider] 工具 "${acc.name}" 的参数 JSON 解析失败，回退为空对象。原始内容: ${acc.args}`,
        );
        input = {};
      }
      yield {
        type: "tool_use",
        toolName: acc.name,
        toolInput: input,
        toolCallId: acc.id || `call_${acc.name}`,
      };
    }

    // 映射 finishReason：length 保持，tool_calls/stop → end_turn 语义
    const mapped = finishReason === "length" ? "length" : finishReason;
    yield { type: "end_turn", stopReason: mapped };
  }
}
