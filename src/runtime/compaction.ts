/**
 * 上下文压缩（Compaction）
 *
 * 参考 PiAgent 的 compaction 设计：当对话历史逼近 token 预算时，
 * 把较早的历史消息交给模型摘要成一条 summary，保留最近若干 token 的消息，
 * 用「summary + 最近消息」替换原历史。这让 Agent 能长时间运行而不撑爆上下文。
 *
 * 与朴素 trim（直接删旧消息）的区别：compaction 不丢信息，而是压缩成摘要。
 */

import type { Message, ModelProvider, StreamEvent } from "../core/types.js";
import { CHARS_PER_TOKEN } from "./context-manager.js";

/** 压缩配置 */
export interface CompactionOptions {
  /** token 预算（按字符估算）。历史超过 budget - reserveTokens 时触发压缩 */
  budget: number;
  /** 为系统提示与模型输出预留的 token（默认 budget 的 12.5%） */
  reserveTokens?: number;
  /** 压缩后保留的最近消息 token 数（默认 budget 的 25%） */
  keepRecentTokens?: number;
  /** 用于生成摘要的模型 */
  model: ModelProvider;
}

/** 压缩结果 */
export interface CompactionResult {
  /** 是否发生了压缩 */
  compacted: boolean;
  /** 压缩后的消息列表 */
  messages: Message[];
  /** 压缩前后 token 估算（发生压缩时有值） */
  tokensBefore?: number;
  tokensAfter?: number;
}

/** 估算消息列表的 token 数（与 ContextManager 同比率） */
function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length + m.role.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** 摘要提示词 */
const SUMMARIZATION_PROMPT =
  "你是对话压缩器。请把下面这段较早的对话历史压缩成一段简洁但信息完整的摘要，" +
  "保留：关键事实、已做的决定、已产出的结果、未完成的任务、重要的文件/数据引用。" +
  "不要遗漏后续对话可能依赖的信息。只输出摘要正文，不要额外解释。\n\n历史：\n";

/**
 * 判断是否需要压缩：历史 token 超过 budget - reserveTokens。
 */
export function shouldCompact(messages: Message[], opts: CompactionOptions): boolean {
  const reserve = opts.reserveTokens ?? Math.floor(opts.budget / 8);
  return estimateTokens(messages) > opts.budget - reserve;
}

/**
 * 找到切割点：从末尾向前累计 token，达到 keepRecentTokens 后，
 * 在一个「完整语义单位」（user 或 assistant 文本消息）处切割，返回索引。
 * 索引之前的消息被压缩，索引及之后的消息保留。
 */
function findCutIndex(messages: Message[], keepRecentTokens: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i]!]);
    if (acc >= keepRecentTokens) {
      // 向后找到第一个 user/assistant 文本消息作为干净切点
      for (let j = i; j < messages.length; j++) {
        const m = messages[j]!;
        if ((m.role === "user" || m.role === "assistant") && m.type === "text") {
          return j;
        }
      }
      return i;
    }
  }
  return 0;
}

/**
 * 执行压缩：把 messages[0..cut) 交给模型摘要，替换为一条 system summary 消息，
 * 保留 messages[cut..] 原样。若无需压缩或历史太短，原样返回。
 */
export async function compactMessages(
  messages: Message[],
  opts: CompactionOptions,
): Promise<CompactionResult> {
  if (!shouldCompact(messages, opts)) {
    return { compacted: false, messages };
  }

  const keepRecent = opts.keepRecentTokens ?? Math.floor(opts.budget / 4);
  const cut = findCutIndex(messages, keepRecent);

  // 切点太靠前，压缩收益不足，跳过
  if (cut <= 1) {
    return { compacted: false, messages };
  }

  const toSummarize = messages.slice(0, cut);
  const retained = messages.slice(cut);
  const tokensBefore = estimateTokens(messages);

  // 用模型生成摘要
  const historyText = toSummarize
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n");
  const summaryInput: Message[] = [
    { id: "compact-in", role: "user", type: "text", content: SUMMARIZATION_PROMPT + historyText, timestamp: 0 },
  ];

  let summaryText = "";
  const stream = opts.model.generate(summaryInput, [], "");
  for await (const ev of stream as AsyncIterable<StreamEvent>) {
    if (ev.type === "content_delta") summaryText += ev.delta;
  }

  const summaryMessage: Message = {
    id: `compaction-${messages.length}`,
    role: "system",
    type: "text",
    content: `[对话历史摘要 — 已压缩 ${toSummarize.length} 条早期消息]\n${summaryText.trim()}`,
    timestamp: 0,
    metadata: { compaction: true, summarizedCount: toSummarize.length },
  };

  const compactedMessages = [summaryMessage, ...retained];
  return {
    compacted: true,
    messages: compactedMessages,
    tokensBefore,
    tokensAfter: estimateTokens(compactedMessages),
  };
}
