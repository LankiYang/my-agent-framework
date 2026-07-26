import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import { Framework } from "../index.js";
import { createAgent, createModel } from "../api.js";
import type { Message, StorageProvider } from "../core/types.js";

function msg(role: Message["role"], content: string): Message {
  return { id: `m-${Math.random()}`, role, type: "text", content, timestamp: 0 };
}

// 回显最后一条 user 消息，但也能看到历史长度（验证历史确实被带上）
function historyAwareModel() {
  return createModel("custom", {
    id: "hist",
    async *generate(messages) {
      const users = messages.filter((m) => m.role === "user").length;
      const last = [...messages].reverse().find((m) => m.role === "user");
      yield { type: "content_delta", delta: `[历史${users}轮] ${last?.content ?? ""}` };
      yield { type: "end_turn", stopReason: "end_turn" };
    },
  });
}

test("SessionManager: 两个会话消息互不干扰", async () => {
  const sm = new SessionManager();
  await sm.append("s1", [msg("user", "A的消息")]);
  await sm.append("s2", [msg("user", "B的消息")]);

  const m1 = await sm.getMessages("s1");
  const m2 = await sm.getMessages("s2");
  assert.equal(m1.length, 1);
  assert.equal(m2.length, 1);
  assert.equal(m1[0]!.content, "A的消息");
  assert.equal(m2[0]!.content, "B的消息");
});

test("SessionManager: userId 过滤会话列表", async () => {
  const sm = new SessionManager();
  await sm.getOrCreate("s1", "alice");
  await sm.getOrCreate("s2", "bob");
  await sm.getOrCreate("s3", "alice");

  const aliceSessions = (await sm.list("alice")).sort();
  assert.deepEqual(aliceSessions, ["s1", "s3"]);
});

test("SessionManager: 持久化后可从存储恢复", async () => {
  // 简单内存 StorageProvider
  const store = new Map<string, unknown>();
  const storage: StorageProvider = {
    async save(k, v) { store.set(k, JSON.parse(JSON.stringify(v))); },
    async load(k) { return (store.get(k) as any) ?? null; },
    async delete(k) { store.delete(k); },
    async list(prefix) { return [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)); },
  };

  const sm1 = new SessionManager({ storage });
  await sm1.append("s1", [msg("user", "持久化消息")]);

  // 新建一个 manager（模拟进程重启），从同一 storage 恢复
  const sm2 = new SessionManager({ storage });
  const restored = await sm2.getMessages("s1");
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.content, "持久化消息");
});

test("Framework: sessionId 隔离两个用户的多轮对话", async () => {
  const fw = new Framework();
  fw.useModel(historyAwareModel());
  fw.useAgent(createAgent({ name: "Chat", model: historyAwareModel(), prompt: "" }));
  await fw.start();

  // 用户 A 的会话，两轮
  await fw.run("A第一句", { agent: "Chat", sessionId: "userA", userId: "A" });
  const a2 = await fw.run("A第二句", { agent: "Chat", sessionId: "userA", userId: "A" });

  // 用户 B 的会话，一轮
  const b1 = await fw.run("B第一句", { agent: "Chat", sessionId: "userB", userId: "B" });

  await fw.stop();

  // A 第二轮应看到多轮历史（累积），B 只有自己这一轮
  assert.match(a2.output, /历史2轮/); // A 的第二次调用，历史里有 2 条 user
  assert.match(b1.output, /历史1轮/); // B 独立会话，只有 1 条

  // 会话隔离：A 的历史不含 B 的消息
  const aMsgs = await fw.sessions.getMessages("userA");
  const hasB = aMsgs.some((m) => m.content.includes("B第一句"));
  assert.equal(hasB, false);
});

test("Framework: 无 sessionId 时为无状态调用（不累积）", async () => {
  const fw = new Framework();
  fw.useModel(historyAwareModel());
  fw.useAgent(createAgent({ name: "Chat", model: historyAwareModel(), prompt: "" }));
  await fw.start();

  await fw.run("第一句", { agent: "Chat" });
  const r2 = await fw.run("第二句", { agent: "Chat" });
  await fw.stop();

  // 无 sessionId，第二次调用不带历史，只有当前 1 轮
  assert.match(r2.output, /历史1轮/);
  assert.equal(fw.sessions.size(), 0); // 未创建任何会话
});
