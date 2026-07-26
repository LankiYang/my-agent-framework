import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLoop } from "./agent-loop.js";
import type { AgentLoopTerminal } from "./agent-loop.js";
import type { Message, StreamEvent, ToolDef } from "../core/types.js";

/** 消费 agentLoop 到终止，返回 terminal */
async function runLoop(
  messages: Message[],
  options: Parameters<typeof agentLoop>[1],
): Promise<AgentLoopTerminal> {
  const gen = agentLoop(messages, options);
  while (true) {
    const { value, done } = await gen.next();
    if (done) return value as AgentLoopTerminal;
  }
}

const userMsg: Message = {
  id: "u1",
  role: "user",
  type: "text",
  content: "hi",
  timestamp: 0,
};

/** 生成只产文本、不调工具的假 model */
function textModel(text: string) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "content_delta", delta: text };
    yield { type: "end_turn", stopReason: "end_turn" };
  };
}

test("正常完成：无工具调用即 completed", async () => {
  const terminal = await runLoop([userMsg], {
    model: { id: "m", generate: textModel("hello") as any },
    tools: [],
    systemPrompt: "",
    deps: { callModel: textModel("hello") as any },
  });
  assert.equal(terminal.reason, "completed");
  const last = terminal.messages[terminal.messages.length - 1];
  assert.equal(last.content, "hello");
});

test("达到 maxTurns 时终止", async () => {
  // model 永远调用工具 → 永不 completed，触发 maxTurns
  const loopingModel = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "tool_use", toolName: "noop", toolInput: {}, toolCallId: "c1" };
    yield { type: "end_turn", stopReason: "tool_use" };
  };
  const noop: ToolDef = {
    name: "noop",
    description: "",
    inputSchema: {},
    isReadOnly: true,
    execute: async () => ({ content: "ok" }),
  };
  const terminal = await runLoop([userMsg], {
    model: { id: "m", generate: loopingModel as any },
    tools: [noop],
    systemPrompt: "",
    maxTurns: 2,
    deps: { callModel: loopingModel as any },
  });
  assert.equal(terminal.reason, "max_turns");
});

test("A2: 工具调用后，独立 tool_call 消息进入历史", async () => {
  let turn = 0;
  const model = async function* (): AsyncGenerator<StreamEvent> {
    turn++;
    if (turn === 1) {
      yield { type: "tool_use", toolName: "greet", toolInput: { name: "bob" }, toolCallId: "c1" };
      yield { type: "end_turn", stopReason: "tool_use" };
    } else {
      yield { type: "content_delta", delta: "done" };
      yield { type: "end_turn", stopReason: "end_turn" };
    }
  };
  const greet: ToolDef = {
    name: "greet",
    description: "",
    inputSchema: {},
    isReadOnly: true,
    execute: async (i) => ({ content: `hi ${i.name}` }),
  };
  const terminal = await runLoop([userMsg], {
    model: { id: "m", generate: model as any },
    tools: [greet],
    systemPrompt: "",
    deps: { callModel: model as any },
  });
  assert.equal(terminal.reason, "completed");
  // 历史里应存在独立的 tool_call 消息和 tool_result 消息
  const hasToolCall = terminal.messages.some(
    (m) => m.role === "assistant" && m.type === "tool_call",
  );
  const hasToolResult = terminal.messages.some(
    (m) => m.role === "tool" && m.type === "tool_result",
  );
  assert.ok(hasToolCall, "历史应包含独立 tool_call 消息");
  assert.ok(hasToolResult, "历史应包含 tool_result 消息");
});

test("abortSignal 已中止时立即返回 aborted_streaming", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const terminal = await runLoop([userMsg], {
    model: { id: "m", generate: textModel("x") as any },
    tools: [],
    systemPrompt: "",
    abortSignal: ctrl.signal,
    deps: { callModel: textModel("x") as any },
  });
  assert.equal(terminal.reason, "aborted_streaming");
});
