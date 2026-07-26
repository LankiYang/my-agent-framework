/**
 * Claude (Anthropic) Model Provider
 *
 * 通过 @anthropic-ai/sdk 接入真实 Claude 模型，实现 ModelProvider 的流式 generate()。
 * SDK 为可选依赖：通过动态 import 加载，未安装时抛出清晰错误，不影响框架其余部分。
 *
 * 消息转换：
 * - 框架的 Message[]（含独立 tool_call / tool_result 消息）→ Anthropic messages（content blocks）
 * - 连续的 assistant 文本 + tool_call 合并进同一条 assistant 消息的 content 数组
 * - tool_result（role=tool）转为 user 角色下的 tool_result block
 */

import { BaseModelProvider } from "./index.js";
import type {
  Message,
  StreamEvent,
  ToolDef,
  ToolCallMessage,
  ToolResultMessage,
} from "../../core/types.js";

/** Claude Provider 配置 */
export interface ClaudeProviderConfig {
  /** API Key，默认取 process.env.ANTHROPIC_API_KEY */
  apiKey?: string;
  /**
   * Auth Token（Bearer 认证），默认取 process.env.ANTHROPIC_AUTH_TOKEN。
   * 用于代理 / 网关场景（如 Claude Code 的本地代理），与 apiKey 二选一。
   */
  authToken?: string;
  /** 模型名，默认 claude-sonnet-4-20250514 */
  model?: string;
  /** 自定义 baseURL（如代理），默认取 process.env.ANTHROPIC_BASE_URL */
  baseURL?: string;
  /** 最大输出 token，默认 4096 */
  maxTokens?: number;
}

/** Anthropic content block（转换目标类型，避免依赖 SDK 类型） */
type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

export class ClaudeModelProvider extends BaseModelProvider {
  private readonly apiKey: string;
  private readonly authToken: string;
  private readonly modelName: string;
  private readonly baseURL?: string;
  private readonly maxTokens: number;
  /** 懒加载的 SDK 客户端 */
  private client: unknown;

  constructor(config: ClaudeProviderConfig = {}) {
    const modelName = config.model ?? "claude-sonnet-4-20250514";
    super(`claude-${modelName}`);
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.authToken = config.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
    this.modelName = modelName;
    this.baseURL = config.baseURL ?? process.env.ANTHROPIC_BASE_URL;
    this.maxTokens = config.maxTokens ?? 4096;
  }

  /** 懒加载并缓存 Anthropic 客户端 */
  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.apiKey && !this.authToken) {
      throw new Error(
        "ClaudeModelProvider: 缺少凭证（设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN，或传入 apiKey/authToken）",
      );
    }
    let Anthropic: any;
    try {
      // 动态 import，SDK 未安装时给出清晰指引
      ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
    } catch {
      throw new Error(
        "ClaudeModelProvider: 未安装 @anthropic-ai/sdk，请运行 `npm install @anthropic-ai/sdk`",
      );
    }
    // 优先 apiKey；仅有 authToken 时用 Bearer 认证（代理/网关场景）
    this.client = new Anthropic({
      ...(this.apiKey ? { apiKey: this.apiKey } : { apiKey: null, authToken: this.authToken }),
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
    return this.client;
  }

  /** 把框架 Message[] 转成 Anthropic messages（system 单独提取） */
  private toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      // system 消息由 systemPrompt 单独处理，跳过
      if (msg.role === "system") continue;

      // tool_result → user 消息里的 tool_result block
      if (msg.role === "tool" && msg.type === "tool_result") {
        const tr = msg as ToolResultMessage;
        const block: AnthropicBlock = {
          type: "tool_result",
          tool_use_id: tr.toolCallId,
          content: tr.content,
          ...(tr.isError ? { is_error: true } : {}),
        };
        // 合并进上一条 user 消息，否则新建
        const last = result[result.length - 1];
        if (last && last.role === "user") {
          last.content.push(block);
        } else {
          result.push({ role: "user", content: [block] });
        }
        continue;
      }

      // assistant 的 tool_call → tool_use block
      if (msg.role === "assistant" && msg.type === "tool_call") {
        const tc = msg as ToolCallMessage;
        const block: AnthropicBlock = {
          type: "tool_use",
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.toolInput,
        };
        const last = result[result.length - 1];
        if (last && last.role === "assistant") {
          last.content.push(block);
        } else {
          result.push({ role: "assistant", content: [block] });
        }
        continue;
      }

      // 普通文本
      const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
      if (!msg.content) continue; // 跳过空文本（如纯 tool_call 的占位 assistantMessage）
      const last = result[result.length - 1];
      if (last && last.role === role) {
        last.content.push({ type: "text", text: msg.content });
      } else {
        result.push({ role, content: [{ type: "text", text: msg.content }] });
      }
    }

    return result;
  }

  /** 把框架 ToolDef[] 转成 Anthropic tools 格式 */
  private toAnthropicTools(tools: ToolDef[]): Array<Record<string, unknown>> {
    return tools.map((t) => {
      const schema = (t.inputSchema && typeof t.inputSchema === "object" && "type" in t.inputSchema)
        ? t.inputSchema
        : { type: "object", properties: {} };
      return {
        name: t.name,
        description: t.description,
        input_schema: schema,
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

    const anthropicMessages = this.toAnthropicMessages(messages);
    const anthropicTools = this.toAnthropicTools(tools);

    // 累积 tool_use 分片：Anthropic 的 input 通过 input_json_delta 分片传输
    const toolUseAccum = new Map<number, { id: string; name: string; json: string }>();
    let stopReason = "end_turn";

    try {
      const stream = await client.messages.create({
        model: this.modelName,
        max_tokens: this.maxTokens,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: anthropicMessages,
        ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        stream: true,
      });

      for await (const event of stream as AsyncIterable<any>) {
        switch (event.type) {
          case "content_block_start": {
            if (event.content_block?.type === "tool_use") {
              toolUseAccum.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                json: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            if (event.delta?.type === "text_delta") {
              yield { type: "content_delta", delta: event.delta.text };
            } else if (event.delta?.type === "input_json_delta") {
              const acc = toolUseAccum.get(event.index);
              if (acc) acc.json += event.delta.partial_json ?? "";
            }
            break;
          }
          case "content_block_stop": {
            const acc = toolUseAccum.get(event.index);
            if (acc) {
              let input: Record<string, unknown> = {};
              try {
                input = acc.json ? JSON.parse(acc.json) : {};
              } catch {
                console.warn(
                  `[ClaudeModelProvider] 工具 "${acc.name}" 的参数 JSON 解析失败，回退为空对象。原始内容: ${acc.json}`,
                );
                input = {};
              }
              yield {
                type: "tool_use",
                toolName: acc.name,
                toolInput: input,
                toolCallId: acc.id,
              };
              toolUseAccum.delete(event.index);
            }
            break;
          }
          case "message_delta": {
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }

    // 映射 stopReason：max_tokens → length（触发 agentLoop 的续写恢复）
    const mapped = stopReason === "max_tokens" ? "length" : stopReason;
    yield { type: "end_turn", stopReason: mapped };
  }
}
