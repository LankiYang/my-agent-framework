/**
 * Token 计数器模块
 * 提供 Token 计数功能，支持多种模型的 estimation 策略
 *
 * 启发式算法规则：
 * - 英文单词: ~1.3 tokens/word
 * - 中文: ~2.5 字符/token
 * - 代码: ~1.0 字符/token（代码中特殊字符多）
 * - 数字: ~1.0 tokens/数字
 * - 标点符号: 每个 ~0.3 tokens
 */

import type { Message } from "../core/types.js";

// ============================================================
// 类型定义
// ============================================================

/** 支持的编码器类型 */
export type TokenizerType = "claude" | "gpt" | "simple";

/** Token 计数结果 */
export interface TokenCountResult {
  /** 总 token 数 */
  total: number;
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 使用的编码器类型 */
  tokenizer: TokenizerType;
}

/** Token 计数详细结果 */
export interface TokenCountDetail {
  /** token 数量 */
  tokens: number;
  /** 字符数 */
  characters: number;
  /** 是否来自精确计数或估算 */
  isExact: boolean;
}

/** Token 计数器配置选项 */
export interface TokenCounterOptions {
  /** 模型名称，影响 token 估算策略 */
  model?: string;
  /** 字符-per-token 估算比例 (默认 4) */
  charsPerToken?: number;
}

// ============================================================
// 模型预设
// ============================================================

/** 内置模型预设，不同模型使用不同的 charsPerToken 比例 */
export const MODEL_PRESETS: Record<string, Partial<TokenCounterOptions>> = {
  "claude-3": { charsPerToken: 3.5 },
  "claude-3.5": { charsPerToken: 3.5 },
  "claude-4": { charsPerToken: 3.5 },
  "gpt-4": { charsPerToken: 4 },
  "gpt-4o": { charsPerToken: 4 },
  "gpt-3.5": { charsPerToken: 4 },
};

// ============================================================
// 内部常量与辅助函数
// ============================================================

/** 代码检测关键词 */
const CODE_KEYWORDS = [
  "```", "function", "class", "import", "export",
  "const", "let", "var", "return", "async", "await",
  "interface", "type", "enum", "=>",
];

/** 中文字符正则（CJK 统一表意文字基本区 + 扩展A区） */
const CHINESE_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
const ENGLISH_WORD_REGEX = /[a-zA-Z]+/g;
const NUMBER_REGEX = /\d+(?:\.\d+)?/g;
const PUNCTUATION_REGEX = /[^\w\s\u4e00-\u9fff\u3400-\u4dbf]/g;

/** 每条消息的格式开销 (tokens) */
const MESSAGE_OVERHEAD = 4;

/**
 * 检测文本是否包含代码模式
 * 匹配 ```, function, class, import 等编程关键词
 */
function hasCodePatterns(text: string): boolean {
  const lowerText = text.toLowerCase();
  let matchCount = 0;
  for (const keyword of CODE_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }
  return false;
}

/**
 * 统计文本段落中的 token 数（非代码文本）
 */
function countTextTokens(text: string): number {
  let tokens = 0;

  const chineseMatches = text.match(CHINESE_REGEX);
  if (chineseMatches) tokens += chineseMatches.length / 2.5;

  const englishMatches = text.match(ENGLISH_WORD_REGEX);
  if (englishMatches) tokens += englishMatches.length * 1.3;

  const numberMatches = text.match(NUMBER_REGEX);
  if (numberMatches) tokens += numberMatches.length * 1.0;

  let remaining = text;
  remaining = remaining.replace(CHINESE_REGEX, " ");
  remaining = remaining.replace(ENGLISH_WORD_REGEX, " ");
  remaining = remaining.replace(NUMBER_REGEX, " ");
  const punctMatches = remaining.match(PUNCTUATION_REGEX);
  if (punctMatches) tokens += punctMatches.length * 0.3;

  const spaceMatches = text.match(/\s/g);
  if (spaceMatches) tokens += spaceMatches.length * 0.1;

  return tokens;
}

/**
 * 高级估算：代码检测 + 段落感知 + 分类计数
 */
function advancedEstimate(text: string): number {
  if (!text) return 0;
  if (hasCodePatterns(text)) {
    return Math.max(1, Math.ceil(text.length / 1.0));
  }
  const paragraphs = text.split(/\n{2,}/);
  const tokens = paragraphs.reduce((sum, para) => sum + countTextTokens(para), 0);
  return Math.max(1, Math.ceil(tokens));
}

// ============================================================
// TokenCounter 类
// ============================================================

/**
 * TokenCounter
 * 提供多种策略的 Token 计数功能
 *
 * 支持 simple/claude/gpt 三种编码器，以及代码检测、段落感知等高级特性。
 * claude 和 gpt 编码器均使用分类计数算法（中文、英文、数字、标点、代码）。
 */
export class TokenCounter {
  private tokenizer: TokenizerType;

  constructor(tokenizer: TokenizerType = "simple") {
    this.tokenizer = tokenizer;
  }

  /** 切换编码器类型 */
  setTokenizer(type: TokenizerType): void {
    this.tokenizer = type;
  }

  /**
   * 计算文本的 token 数
   */
  count(text: string, tokenizer?: TokenizerType): number {
    const t = tokenizer ?? this.tokenizer;
    switch (t) {
      case "claude":
        return this.claudeEstimate(text);
      case "gpt":
        return this.gptEstimate(text);
      case "simple":
      default:
        return this.simpleEstimate(text);
    }
  }

  /**
   * 计算文本的 token 数（详细结果）
   */
  countDetailed(text: string, tokenizer?: TokenizerType): TokenCountDetail {
    const tokens = this.count(text, tokenizer);
    return { tokens, characters: text.length, isExact: false };
  }

  /**
   * 计算消息列表的 token 数
   */
  countMessages(messages: Message[], tokenizer?: TokenizerType): number {
    return messages.reduce((total, msg) => {
      return total + MESSAGE_OVERHEAD + this.count(msg.content, tokenizer);
    }, 0);
  }

  /**
   * 计算完整的 TokenCountResult（含输入/输出拆分）
   */
  countWithUsage(input: string, output: string, tokenizer?: TokenizerType): TokenCountResult {
    const t = tokenizer ?? this.tokenizer;
    const inputTokens = this.count(input, t);
    const outputTokens = this.count(output, t);
    return {
      total: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      tokenizer: t,
    };
  }

  /**
   * 估算系统提示词 + 消息 + 工具描述的 token 预算使用量
   * @returns 总 token 数和分类明细（system / messages / tools）
   */
  estimateUsage(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    tools?: Array<{ name: string; description: string }>,
  ): { total: number; breakdown: { system: number; messages: number; tools: number } } {
    const systemTokens = this.count(systemPrompt);
    let messagesTokens = 0;
    for (const msg of messages) {
      messagesTokens += MESSAGE_OVERHEAD + this.count(msg.content);
    }

    let toolsTokens = 0;
    if (tools) {
      for (const tool of tools) {
        toolsTokens += this.count(`${tool.name} ${tool.description}`);
      }
    }

    return {
      total: systemTokens + messagesTokens + toolsTokens,
      breakdown: { system: systemTokens, messages: messagesTokens, tools: toolsTokens },
    };
  }

  /**
   * 检查是否在 token 预算内
   */
  isWithinBudget(usage: number | TokenCountDetail, budget: number): boolean {
    const tokens = typeof usage === "number" ? usage : usage.tokens;
    return tokens <= budget;
  }

  // ============================================================
  // 私有估计算法
  // ============================================================

  /**
   * 简易估算：字符数 / 4
   */
  private simpleEstimate(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Claude 估算策略（高级启发式）
   * 使用代码检测 + 段落感知 + 分类计数
   */
  private claudeEstimate(text: string): number {
    if (!text) return 0;
    return advancedEstimate(text);
  }

  /**
   * GPT 估算策略（高级启发式）
   * 使用代码检测 + 段落感知 + 分类计数
   */
  private gptEstimate(text: string): number {
    if (!text) return 0;
    return advancedEstimate(text);
  }
}

// ============================================================
// 全局便利函数
// ============================================================

/** 全局默认 TokenCounter 实例 */
const defaultCounter = new TokenCounter("simple");

/**
 * 计算文本的 token 数（使用默认计数器）
 */
export function countTokens(text: string, tokenizer?: TokenizerType): number {
  return defaultCounter.count(text, tokenizer);
}

/**
 * 检查消息是否超出 token 预算
 */
export function isWithinTokenBudget(
  messages: Array<{ role: string; content: string }>,
  budget: number,
  tokenizer?: TokenizerType,
): boolean {
  const counter = new TokenCounter(tokenizer);
  const total = messages.reduce(
    (sum, msg) => sum + MESSAGE_OVERHEAD + counter.count(msg.content, tokenizer),
    0,
  );
  return total <= budget;
}
