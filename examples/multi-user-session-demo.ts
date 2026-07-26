/**
 * 多用户会话隔离演示（真实 Claude）
 *
 * 同一个 Framework 实例，同时服务两个用户：
 * - 每个用户有独立 sessionId，多轮对话各自记忆
 * - 用户 A 告诉 agent 一个"暗号"，只有 A 的后续对话记得，B 问不出来
 *
 * 运行: npx tsx examples/multi-user-session-demo.ts
 */
import { createModel, createAgent, createApp } from "../src/index.js";

async function main() {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  const claude = createModel("claude", { model });

  const assistant = createAgent({
    name: "Assistant",
    model: claude,
    prompt: "你是简洁的助手，回答控制在一句话。",
    permissionMode: "Bypass",
  });

  const app = createApp({ agents: [assistant], model: claude });

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   多用户会话隔离演示 (真实 Claude)                ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\n模型: ${model}\n一个 Framework 实例，两个独立用户会话\n` + "─".repeat(52));

  // 用户 Alice：先告诉暗号，再让 agent 复述
  console.log("\n👤 [Alice / session=alice] 第 1 轮");
  const a1 = await app.chat("记住我的暗号是「蓝色向日葵」，先回复收到。", {
    sessionId: "alice",
    userId: "alice",
  });
  console.log("   🤖", a1.output);

  // 用户 Bob：独立会话，告诉不同的暗号
  console.log("\n👤 [Bob / session=bob] 第 1 轮");
  const b1 = await app.chat("记住我的暗号是「红色闪电」，先回复收到。", {
    sessionId: "bob",
    userId: "bob",
  });
  console.log("   🤖", b1.output);

  // Alice 第 2 轮：问自己的暗号 —— 应答对
  console.log("\n👤 [Alice / session=alice] 第 2 轮");
  const a2 = await app.chat("我的暗号是什么？", { sessionId: "alice", userId: "alice" });
  console.log("   🤖", a2.output);

  // Bob 第 2 轮：问自己的暗号 —— 应答红色闪电，绝不能是蓝色向日葵
  console.log("\n👤 [Bob / session=bob] 第 2 轮");
  const b2 = await app.chat("我的暗号是什么？", { sessionId: "bob", userId: "bob" });
  console.log("   🤖", b2.output);

  console.log("\n" + "═".repeat(52));
  const aliceCorrect = a2.output.includes("蓝色向日葵") && !a2.output.includes("红色闪电");
  const bobCorrect = b2.output.includes("红色闪电") && !b2.output.includes("蓝色向日葵");
  console.log(`Alice 记得自己的暗号且不串味: ${aliceCorrect ? "✅" : "❌"}`);
  console.log(`Bob   记得自己的暗号且不串味: ${bobCorrect ? "✅" : "❌"}`);

  // 会话管理器视角
  const sessions = await app.framework.sessions.list();
  console.log(`\n活跃会话: [${sessions.join(", ")}]`);
  console.log(`Alice 会话消息数: ${(await app.framework.sessions.getMessages("alice")).length}`);
  console.log(`Bob   会话消息数: ${(await app.framework.sessions.getMessages("bob")).length}`);

  const ok = aliceCorrect && bobCorrect;
  console.log(ok ? "\n🎉 多用户会话隔离真实跑通" : "\n⚠️ 会话隔离有问题");
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("\n❌ 出错:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
