/**
 * 组合能力真实演示：agent-as-tool + 嵌套编排（真实 Claude）
 *
 * 结构：
 *   Writer（主 Agent）
 *     └─ 工具 ask_researcher = agentAsTool(Researcher)  ← Agent 当工具
 *   最终把 Writer 放进 pipe(Writer, Editor) 流水线
 *
 * 运行: npx tsx examples/composition-demo.ts
 */
import { createModel, createAgent, agentAsTool, pipe, Framework } from "../src/index.js";

async function main() {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  const claude = createModel("claude", { model });

  // 共享一个 Framework 给子 Agent 复用（避免每次调用新建/销毁）
  const shared = new Framework();
  shared.useModel(claude);

  // 子 Agent：研究员
  const researcher = createAgent({
    name: "Researcher",
    model: claude,
    prompt: "你是资料研究员。针对给定主题，用 3 条要点给出关键事实，简洁准确。",
    permissionMode: "Bypass",
  });

  // 主 Agent：写作者，把研究员当工具调用
  const writer = createAgent({
    name: "Writer",
    model: claude,
    prompt:
      "你是科普作者。写作前先调用 ask_researcher 工具获取要点，再基于要点写一段 100 字左右的通俗介绍。",
    tools: [
      agentAsTool(researcher, {
        framework: shared,
        description: "就某主题做资料调研，返回 3 条关键事实要点",
      }),
    ],
    permissionMode: "Bypass",
  });

  // 编辑 Agent：润色
  const editor = createAgent({
    name: "Editor",
    model: claude,
    prompt: "你是编辑。润色上一环节的文字，使其更流畅，输出最终版。不要加前言，直接给成品。",
    permissionMode: "Bypass",
  });

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  组合能力演示: agent-as-tool + pipe (真实 Claude)  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\n模型: ${model}`);
  console.log("结构: pipe( Writer[含 ask_researcher 子Agent工具] → Editor )\n");

  const topic = "写一段介绍「黑洞」的科普文字";
  console.log(`📋 任务: ${topic}\n${"─".repeat(52)}`);

  const t0 = Date.now();
  const result = await pipe(writer, editor).run(topic);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  result.agentResults.forEach((r, i) => {
    console.log(`\n━━━ [${i + 1}] ${["Writer (调用了 Researcher 子Agent)", "Editor"][i]} ━━━`);
    console.log(r.output);
  });

  await shared.stop();

  console.log("\n" + "═".repeat(52));
  console.log(`✅ 完成 (${elapsed}s) — 环节数: ${result.agentResults.length}`);

  // 收紧断言：Writer 输出不应包含工具失败痕迹，且两环节都有实质输出
  const writerOut = result.agentResults[0]?.output ?? "";
  const toolFailed = /start\(\)|框架未启动|工具调用失败|无法使用/.test(writerOut);
  const ok =
    result.agentResults.length === 2 &&
    result.output.length > 20 &&
    !toolFailed;
  console.log(`Writer 是否成功调用子 Agent 工具: ${toolFailed ? "❌ 否（工具报错）" : "✅ 是"}`);
  console.log(ok ? "🎉 组合能力（Agent当工具 + 流水线）真实跑通" : "⚠️ 组合链路有问题");
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("\n❌ 出错:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
