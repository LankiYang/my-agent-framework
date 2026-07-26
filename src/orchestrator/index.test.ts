import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SequentialOrchestrator,
  ParallelOrchestrator,
  RouterOrchestrator,
  SupervisorOrchestrator,
} from "./index.js";
import { OrchestratorStrategy } from "../core/types.js";
import type { AgentDef, AgentResult } from "../core/types.js";

function agent(id: string, name = id): AgentDef {
  return { id, name, model: "echo", systemPrompt: "", tools: [] };
}

/** 假 executor：把 input 原样加工，记录每个 agent 收到的 input */
function recordingExecutor(record: Array<{ id: string; input: string }>) {
  return async (a: AgentDef, input: string): Promise<AgentResult> => {
    record.push({ id: a.id, input });
    return {
      output: `${a.id}(${input})`,
      messages: [],
      metadata: { agentId: a.id },
    };
  };
}

test("Sequential：前一个输出作为后一个输入", async () => {
  const record: Array<{ id: string; input: string }> = [];
  const orch = new SequentialOrchestrator({
    id: "seq",
    agents: [agent("A"), agent("B")],
    strategy: OrchestratorStrategy.Sequential,
  });
  orch.setAgentExecutor(recordingExecutor(record));
  const res = await orch.run({ input: "start" });

  assert.equal(record[0].input, "start");
  assert.equal(record[1].input, "A(start)"); // B 收到 A 的输出
  assert.equal(res.output, "B(A(start))");
});

test("Parallel：所有 Agent 收到相同输入，汇总结果", async () => {
  const record: Array<{ id: string; input: string }> = [];
  const orch = new ParallelOrchestrator({
    id: "par",
    agents: [agent("X"), agent("Y")],
    strategy: OrchestratorStrategy.Parallel,
  });
  orch.setAgentExecutor(recordingExecutor(record));
  const res = await orch.run({ input: "task" });

  assert.equal(record.length, 2);
  assert.ok(record.every((r) => r.input === "task"));
  assert.match(res.output, /X\(task\)/);
  assert.match(res.output, /Y\(task\)/);
});

test("Router：route 函数决定目标 Agent", async () => {
  const record: Array<{ id: string; input: string }> = [];
  const orch = new RouterOrchestrator({
    id: "router",
    agents: [agent("code"), agent("chat")],
    strategy: OrchestratorStrategy.Router,
    route: async (input, agents) =>
      agents.find((a) => a.id === (input.includes("code") ? "code" : "chat"))!,
  });
  orch.setAgentExecutor(recordingExecutor(record));
  await orch.run({ input: "write code" });

  assert.equal(record.length, 1);
  assert.equal(record[0].id, "code");
});

test("Supervisor：解析 JSON 分派计划并执行 worker", async () => {
  const record: Array<{ id: string; input: string }> = [];
  const workers = [agent("w1"), agent("w2")];
  const supervisor = agent("boss");
  const orch = new SupervisorOrchestrator(
    { id: "sup", agents: workers, strategy: OrchestratorStrategy.Supervisor },
    supervisor,
  );
  // supervisor 返回 JSON 计划；worker 走 recording
  orch.setAgentExecutor(async (a, input) => {
    record.push({ id: a.id, input });
    if (a.id === "boss") {
      return {
        output: JSON.stringify([{ agentId: "w1", task: "do-1" }]),
        messages: [],
        metadata: {},
      };
    }
    return { output: `${a.id}-done`, messages: [], metadata: {} };
  });
  const res = await orch.run({ input: "big task" });

  // boss 先跑，然后 w1 收到 "do-1"
  assert.equal(record[0].id, "boss");
  assert.ok(record.some((r) => r.id === "w1" && r.input === "do-1"));
  assert.match(res.output, /w1-done/);
});

test("S2: per-run executor 并发隔离，不再互相覆盖", async () => {
  // 同一个 orchestrator 实例，两个并发 run 各带不同 executor（带延迟制造交错）
  const orch = new SequentialOrchestrator({
    id: "shared",
    agents: [agent("A")],
    strategy: OrchestratorStrategy.Sequential,
  });

  const makeExecutor = (tag: string) =>
    async (a: AgentDef, input: string): Promise<AgentResult> => {
      await new Promise((r) => setTimeout(r, 20)); // 制造交错窗口
      return { output: `${tag}:${input}`, messages: [], metadata: {} };
    };

  // 并发跑两个 run，各自的 executor 必须互不串
  const [r1, r2] = await Promise.all([
    orch.run({ input: "x", executor: makeExecutor("RUN1") }),
    orch.run({ input: "y", executor: makeExecutor("RUN2") }),
  ]);

  assert.equal(r1.output, "RUN1:x");
  assert.equal(r2.output, "RUN2:y");
});

test("S2: 无 executor 时回退到 echo 桩（向后兼容）", async () => {
  const orch = new SequentialOrchestrator({
    id: "noexec",
    agents: [agent("A")],
    strategy: OrchestratorStrategy.Sequential,
  });
  const res = await orch.run({ input: "hello" });
  // echo 桩：output 即 input
  assert.equal(res.output, "hello");
});
