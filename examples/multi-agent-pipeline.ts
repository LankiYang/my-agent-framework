/**
 * 多 Agent 代码流水线演示（真实 Claude）
 *
 * 编排：需求 → [Coder 写代码] → [Reviewer 审查] → [Summarizer 出结论]
 * - 用 pipe() 顺序编排，前一个 Agent 的输出作为后一个的输入
 * - Coder 配一个 save_code 工具，验证工具往返在编排链路内生效
 * - 三个 Agent 共用同一个真实 Claude provider（经代理环境变量接入）
 *
 * 运行: npx tsx examples/multi-agent-pipeline.ts
 */
import { createModel, createTool, createAgent, pipe } from "../src/index.js";

async function main() {
  const modelName = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  const claude = createModel("claude", { model: modelName }); // 凭证走环境变量

  // Coder 的工具：把最终代码"保存"下来（这里存内存，演示工具往返）
  const savedCode: { lang: string; code: string }[] = [];
  const saveCode = createTool({
    name: "save_code",
    description: "保存最终确定的代码。当你写好代码后调用它提交。",
    schema: {
      type: "object",
      properties: {
        language: { type: "string", description: "编程语言" },
        code: { type: "string", description: "完整的代码内容" },
      },
      required: ["language", "code"],
    },
    execute: async ({ language, code }) => {
      savedCode.push({ lang: language as string, code: code as string });
      console.log(`\n  🔧 [工具] save_code 被调用 (${language}, ${(code as string).length} 字符)`);
      return "代码已保存成功";
    },
  });

  const coder = createAgent({
    name: "Coder",
    model: claude,
    prompt:
      "你是资深工程师。根据需求写出简洁、正确的代码，然后调用 save_code 工具保存。" +
      "保存后，用一段话说明你的实现思路，把代码也附在回复里，供下一环节审查。",
    tools: [saveCode],
    maxTurns: 5,
    permissionMode: "Bypass",
  });

  const reviewer = createAgent({
    name: "Reviewer",
    model: claude,
    prompt:
      "你是严格的代码审查员。审查上一环节给出的代码，指出潜在 bug、边界情况、可读性问题，" +
      "并给出具体改进建议。用条目列出。如果代码没问题也要明确说明。",
    maxTurns: 3,
    permissionMode: "Bypass",
  });

  const summarizer = createAgent({
    name: "Summarizer",
    model: claude,
    prompt:
      "你是技术负责人。基于前面的代码和审查意见，输出一份简短结论：" +
      "1) 代码是否可合并 2) 必须修复的问题（如有）3) 一句话总评。",
    maxTurns: 3,
    permissionMode: "Bypass",
  });

  const requirement =
    "用 TypeScript 实现一个函数 chunk<T>(arr: T[], size: number): T[][]，" +
    "把数组按 size 切成多个子数组。要求处理 size<=0 的非法输入。";

  console.log("╔════════════════════════════════════════════════╗");
  console.log("║   多 Agent 代码流水线 (真实 Claude)            ║");
  console.log("╚════════════════════════════════════════════════╝");
  console.log(`\n模型: ${modelName}`);
  console.log(`\n📋 需求:\n   ${requirement}\n`);
  console.log("流水线: Coder → Reviewer → Summarizer");
  console.log("─".repeat(52));

  const t0 = Date.now();
  const pipeline = pipe(coder, reviewer, summarizer);
  const result = await pipeline.run(requirement);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // 逐环节输出
  const names = ["Coder", "Reviewer", "Summarizer"];
  result.agentResults.forEach((r, i) => {
    console.log(`\n\n━━━━━━ [${i + 1}] ${names[i]} ━━━━━━`);
    console.log(r.output);
  });

  console.log("\n" + "═".repeat(52));
  console.log(`✅ 流水线完成 (${elapsed}s)`);
  console.log(`   环节数: ${result.agentResults.length}`);
  console.log(`   save_code 工具调用次数: ${savedCode.length}`);
  console.log(`   策略: ${result.metadata.strategy}`);

  const ok =
    result.agentResults.length === 3 &&
    savedCode.length >= 1 &&
    result.agentResults.every((r) => typeof r.output === "string" && r.output.length > 0);
  console.log(ok ? "\n🎉 多 Agent 编排测试通过" : "\n⚠️ 结果不完整");
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("\n❌ 出错:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
