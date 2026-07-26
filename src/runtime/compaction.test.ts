import { test } from "node:test";
import assert from "node:assert/strict";
import { compactMessages, shouldCompact } from "./compaction.js";
import type { Message, ModelProvider, StreamEvent } from "../core/types.js";

function msg(role: Message["role"], content: string): Message {
  return { id: `m-${Math.random()}`, role, type: "text", content, timestamp: 0 };
}

// 假模型：摘要固定返回 "SUMMARY"
const summarizer: ModelProvider = {
  id: "summarizer",
  async *generate(): AsyncGenerator<StreamEvent> {
    yield { type: "content_delta", delta: "SUMMARY" };
    yield { type: "end_turn", stopReason: "end_turn" };
  },
};

// 构造一段长历史：许多条各 400 字符的消息
function longHistory(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push(msg(i % 2 === 0 ? "user" : "assistant", `消息${i}:` + "x".repeat(400)));
  }
  return out;
}

test("shouldCompact: 历史短不触发、历史长触发", () => {
  const short = [msg("user", "hi")];
  assert.equal(shouldCompact(short, { budget: 1000, model: summarizer }), false);

  const long = longHistory(40); // 约 40*100 = 4000 token
  assert.equal(shouldCompact(long, { budget: 1000, model: summarizer }), true);
});

test("compactMessages: 触发后用摘要替换早期历史，保留最近消息", async () => {
  const history = longHistory(40);
  const result = await compactMessages(history, {
    budget: 1000,
    keepRecentTokens: 250,
    model: summarizer,
  });

  assert.equal(result.compacted, true);
  // 第一条应是压缩摘要（system 消息含 SUMMARY）
  assert.equal(result.messages[0]!.role, "system");
  assert.match(result.messages[0]!.content, /SUMMARY/);
  assert.equal(result.messages[0]!.metadata?.compaction, true);
  // 压缩后消息数应远少于原始
  assert.ok(result.messages.length < history.length);
  // 压缩后 token 应下降
  assert.ok((result.tokensAfter ?? 0) < (result.tokensBefore ?? 0));
  // 最近的消息应被保留（最后一条内容不变）
  assert.equal(result.messages[result.messages.length - 1]!.content, history[history.length - 1]!.content);
});

test("compactMessages: 历史未超预算时原样返回，不调用模型", async () => {
  let called = false;
  const spyModel: ModelProvider = {
    id: "spy",
    async *generate(): AsyncGenerator<StreamEvent> {
      called = true;
      yield { type: "end_turn", stopReason: "end_turn" };
    },
  };
  const short = [msg("user", "hi"), msg("assistant", "hello")];
  const result = await compactMessages(short, { budget: 100000, model: spyModel });
  assert.equal(result.compacted, false);
  assert.equal(called, false);
  assert.equal(result.messages, short);
});
