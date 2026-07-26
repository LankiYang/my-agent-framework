import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolExecutor } from "./tool-executor.js";
import { PermissionEngine, PermissionMode } from "./permission.js";
import type { ToolDef, ToolCallMessage, SharedContext } from "../core/types.js";

const ctx: SharedContext = { messages: [], artifacts: {}, metadata: {} };

function call(name: string, input: Record<string, unknown> = {}): ToolCallMessage {
  return {
    id: `tc_${name}`,
    role: "assistant",
    type: "tool_call",
    content: "",
    timestamp: 0,
    toolName: name,
    toolInput: input,
    toolCallId: `id_${name}`,
  };
}

const echoTool: ToolDef = {
  name: "echo",
  description: "echo",
  inputSchema: {},
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (input) => ({ content: `echo:${input.text}` }),
};

const writeTool: ToolDef = {
  name: "write",
  description: "write",
  inputSchema: {},
  isReadOnly: false,
  execute: async () => ({ content: "written" }),
};

const slowTool: ToolDef = {
  name: "slow",
  description: "slow",
  inputSchema: {},
  isReadOnly: true,
  timeout: 50,
  execute: async () => {
    await new Promise((r) => setTimeout(r, 500));
    return { content: "done" };
  },
};

test("executeSingle 正常执行返回结果", async () => {
  const exec = new ToolExecutor([echoTool]);
  const res = await exec.executeSingle(call("echo", { text: "hi" }), ctx);
  assert.equal(res.isError, false);
  assert.equal(res.content, "echo:hi");
});

test("未知工具返回错误结果", async () => {
  const exec = new ToolExecutor([echoTool]);
  const res = await exec.executeSingle(call("nope"), ctx);
  assert.equal(res.isError, true);
  assert.match(res.content, /未找到工具/);
});

test("超时工具返回错误", async () => {
  const exec = new ToolExecutor([slowTool]);
  const res = await exec.executeSingle(call("slow"), ctx);
  assert.equal(res.isError, true);
  assert.match(res.content, /超时/);
});

test("A3: Default 模式下写工具无 askHandler → 拒绝（不静默放行）", async () => {
  const engine = new PermissionEngine();
  const exec = new ToolExecutor([writeTool], engine, PermissionMode.Default);
  const res = await exec.executeSingle(call("write"), ctx);
  assert.equal(res.isError, true);
  assert.match(res.content, /权限拒绝/);
});

test("A3: askHandler 返回 true → 放行执行", async () => {
  const engine = new PermissionEngine();
  const exec = new ToolExecutor([writeTool], engine, PermissionMode.Default, async () => true);
  const res = await exec.executeSingle(call("write"), ctx);
  assert.equal(res.isError, false);
  assert.equal(res.content, "written");
});

test("A3: askHandler 返回 false → 拒绝", async () => {
  const engine = new PermissionEngine();
  const exec = new ToolExecutor([writeTool], engine, PermissionMode.Default, async () => false);
  const res = await exec.executeSingle(call("write"), ctx);
  assert.equal(res.isError, true);
  assert.match(res.content, /被拒绝/);
});

test("executeMany：并发安全工具并行、结果齐全", async () => {
  const exec = new ToolExecutor([echoTool]);
  const results = await exec.executeMany(
    [call("echo", { text: "a" }), call("echo", { text: "b" })],
    ctx,
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.type === "tool_result"));
});
