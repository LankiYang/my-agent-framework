import { test } from "node:test";
import assert from "node:assert/strict";
import { createModel, createAgent, createTool, agentAsTool, pipe, parallel } from "../api.js";
import { EchoModelProvider } from "../provider/model/index.js";
import { Framework } from "../index.js";

// 一个确定性假 provider：回显最后一条 user 消息，前缀标注 agent 名从 systemPrompt 推断
function tagModel(tag: string) {
  return createModel("custom", {
    id: `tag-${tag}`,
    async *generate(messages) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      yield { type: "content_delta", delta: `[${tag}] ${lastUser?.content ?? ""}` };
      yield { type: "end_turn", stopReason: "end_turn" };
    },
  });
}

test("B4: agentAsTool 把 Agent 包装成可调用工具", async () => {
  const sub = createAgent({ name: "SubAgent", model: tagModel("SUB"), prompt: "" });
  const tool = agentAsTool(sub, { description: "委派给子 agent" });

  assert.equal(tool.name, "ask_subagent");
  assert.equal(tool.isReadOnly, false);

  const out = await tool.execute({ input: "hello" }, { messages: [], artifacts: {}, metadata: {} });
  assert.match(out.content, /\[SUB\] hello/);
});

test("B4: agentAsTool 复用外部 framework（含未 start 的情形）", async () => {
  const sub = createAgent({ name: "Helper", model: tagModel("HELP"), prompt: "" });
  const shared = new Framework();
  shared.useModel(tagModel("HELP")); // 注册模型但故意不 start()
  const tool = agentAsTool(sub, { framework: shared });

  // execute 应自动确保 framework 已启动，而非抛"框架未启动"
  const out = await tool.execute({ input: "ping" }, { messages: [], artifacts: {}, metadata: {} });
  assert.match(out.content, /\[HELP\] ping/);
  await shared.stop();
});

test("B5: pipe 顺序编排真实驱动不同 Agent", async () => {
  const a = createAgent({ name: "A", model: tagModel("A"), prompt: "" });
  const b = createAgent({ name: "B", model: tagModel("B"), prompt: "" });
  const result = await pipe(a, b).run("start");
  // A 先跑输出 "[A] start"，B 收到它输出 "[B] [A] start"
  assert.match(result.output, /\[B\] \[A\] start/);
  assert.equal(result.agentResults.length, 2);
});

test("B5: 编排可嵌套 —— parallel().asAgent() 作为 pipe 的一环", async () => {
  const a = createAgent({ name: "A", model: tagModel("A"), prompt: "" });
  const b = createAgent({ name: "B", model: tagModel("B"), prompt: "" });
  const reviewer = createAgent({ name: "R", model: tagModel("R"), prompt: "" });

  const nestedAgent = parallel(a, b).asAgent("并行组");
  assert.equal(nestedAgent.name, "并行组");
  assert.ok(nestedAgent.modelProvider, "嵌套单元应带 modelProvider");

  const result = await pipe(nestedAgent, reviewer).run("task");
  // 并行组先跑（输出含 A、B），reviewer 再包一层 [R]
  assert.match(result.output, /\[R\]/);
  assert.equal(result.agentResults.length, 2);
});

test("permissionMode 无效值在 createAgent 即抛错", () => {
  assert.throws(
    () => createAgent({ name: "X", model: tagModel("X"), permissionMode: "NoSuchMode" as any }),
    /无效的 permissionMode/,
  );
});

test("permissionMode 接受枚举键与枚举值两种写法", () => {
  const byKey = createAgent({ name: "X", model: tagModel("X"), permissionMode: "Bypass" });
  const byValue = createAgent({ name: "Y", model: tagModel("Y"), permissionMode: "bypass" as any });
  assert.equal(byKey.permissionMode, "bypass");
  assert.equal(byValue.permissionMode, "bypass");
});

test("EchoModelProvider 仍可用（回归）", async () => {
  const echo = new EchoModelProvider("echo");
  const agent = createAgent({ name: "E", model: echo, prompt: "" });
  assert.equal(agent.modelProvider?.id, "echo");
});

test("P1: runStream 流式 yield 事件并 return terminal", async () => {
  const fw = new Framework();
  fw.useModel(tagModel("S"));
  fw.useAgent(createAgent({ name: "Streamer", model: tagModel("S"), prompt: "" }));
  await fw.start();

  const events: string[] = [];
  const gen = fw.runStream("hi", { agent: "Streamer" });
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value.type);
    next = await gen.next();
  }
  const terminal = next.value;

  await fw.stop();
  // 至少应看到 turn_start、content_delta、turn_end 事件
  assert.ok(events.includes("content_delta"), "应 yield content_delta 事件");
  assert.ok(events.includes("turn_start"), "应 yield turn_start 事件");
  assert.equal(terminal.reason, "completed");
});
