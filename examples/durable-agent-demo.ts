/**
 * 耐久 Agent 演示（真实 Claude）——集成从 PiAgent 借鉴的四项能力：
 *   1. 流式输出（chatStream / runStream）
 *   2. 内置工具经 ExecutionEnv（read / bash）
 *   3. Skill 指导（声明式能力）
 *   4. 上下文压缩预算（contextBudget，长任务不撑爆）
 *
 * 运行: npx tsx examples/durable-agent-demo.ts
 */
import {
  createModel,
  createAgent,
  createApp,
  createReadTool,
  createBashTool,
  NodeExecutionEnv,
} from "../src/index.js";
import type { Skill } from "../src/index.js";

async function main() {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  const claude = createModel("claude", { model });

  // 执行环境：以本项目 src 目录为工作区
  const env = new NodeExecutionEnv(process.cwd());

  // 一个技能：指导 agent 如何做"代码库速览"
  const surveySkill: Skill = {
    name: "codebase-survey",
    description: "需要快速了解一个代码库结构时使用",
    content:
      "速览步骤：1) 用 bash 执行 `ls src` 看顶层结构；2) 挑 1-2 个关键文件用 read 读取；" +
      "3) 用不超过 5 句话总结这个项目是做什么的、核心模块有哪些。不要罗列所有文件。",
  };

  const explorer = createAgent({
    name: "Explorer",
    model: claude,
    prompt: "你是代码库速览助手。遵循 codebase-survey 技能完成速览。",
    tools: [createReadTool(), createBashTool()],
    skills: [surveySkill],
    contextBudget: 100_000, // 启用上下文压缩，长任务不撑爆
    permissionMode: "Bypass",
    maxTurns: 8,
  });

  const app = createApp({ agents: [explorer], model: claude, env });

  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║  耐久 Agent 演示: 流式 + 内置工具 + Skill (真实 Claude) ║");
  console.log("╚════════════════════════════════════════════════════╝");
  console.log(`\n模型: ${model}`);
  console.log("能力: chatStream 流式 · read/bash 经 ExecutionEnv · codebase-survey 技能\n");
  console.log("任务: 速览当前项目的 src 目录\n" + "─".repeat(54) + "\n");

  // 流式消费：实时打印文本增量与工具调用
  let toolCalls = 0;
  let sawText = false;
  const gen = app.chatStream("速览一下这个项目，告诉我它是做什么的");
  let next = await gen.next();
  while (!next.done) {
    const ev = next.value;
    if (ev.type === "content_delta") {
      process.stdout.write(ev.delta);
      sawText = true;
    } else if (ev.type === "tool_exec_start") {
      toolCalls++;
      process.stdout.write(`\n  🔧 [工具] ${ev.toolName}\n`);
    } else if (ev.type === "compact") {
      process.stdout.write(`\n  🗜️  [压缩] ${ev.tokensBefore}→${ev.tokensAfter} tokens\n`);
    }
    next = await gen.next();
  }
  const terminal = next.value;

  console.log("\n\n" + "═".repeat(54));
  console.log(`✅ 完成 — 停止原因: ${terminal.reason} · 轮次: ${terminal.turnCount}`);
  console.log(`   工具调用: ${toolCalls} 次 · 流式文本: ${sawText ? "有" : "无"}`);

  const ok = terminal.reason === "completed" && toolCalls >= 1 && sawText;
  console.log(ok ? "🎉 耐久 Agent 四项能力真实跑通" : "⚠️ 结果不完整");
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("\n❌ 出错:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
