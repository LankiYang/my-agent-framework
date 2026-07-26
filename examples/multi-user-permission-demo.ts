/**
 * 身份感知权限演示（真实 Claude）
 *
 * 同一个 Framework、同一个 agent，按请求者身份分权：
 * - admin 角色：可以用 bash 工具
 * - guest 角色：bash 被拒绝（框架层拦截，agent 拿到"权限拒绝"结果）
 *
 * 运行: npx tsx examples/multi-user-permission-demo.ts
 */
import { createModel, createAgent, createApp, createBashTool } from "../src/index.js";

async function main() {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  const claude = createModel("claude", { model });

  const agent = createAgent({
    name: "Ops",
    model: claude,
    prompt: "你是运维助手。需要执行命令时用 bash 工具。如果工具返回权限拒绝，如实告诉用户你没有该权限。",
    tools: [createBashTool()],
    permissionMode: "Bypass", // 放开默认 Ask，改由身份规则控制
  });

  const app = createApp({ agents: [agent], model: claude });
  if (!app.framework.isRunning) await app.framework.start();

  // 身份规则：bash 仅限 admin 角色
  app.framework.permissions.restrictToolToRole("bash", "admin");

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   身份感知权限演示 (真实 Claude)                  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\n模型: ${model}\n规则: bash 工具仅限 admin 角色\n` + "─".repeat(52));

  const task = "执行 `echo hello-from-bash` 并把输出告诉我";

  // admin 请求 —— 应能用 bash
  console.log("\n👤 [admin] 请求执行命令");
  const adminRes = await app.chat(task, { sessionId: "s-admin", userId: "u1", role: "admin" });
  console.log("   🤖", adminRes.output.replace(/\n/g, " ").slice(0, 200));

  // guest 请求 —— bash 应被拒绝
  console.log("\n👤 [guest] 请求执行命令");
  const guestRes = await app.chat(task, { sessionId: "s-guest", userId: "u2", role: "guest" });
  console.log("   🤖", guestRes.output.replace(/\n/g, " ").slice(0, 200));

  await app.framework.stop();

  console.log("\n" + "═".repeat(52));
  // admin 应真正拿到命令的执行结果；guest 应体现被拒绝（且未真正执行）
  const adminGotOutput = /hello-from-bash/.test(adminRes.output);
  // guest 被拒的判据：回复里表达了"无权限/被拒绝"，而非仅仅复述命令
  const guestDenied = /权限|拒绝|无权|denied|permission|not authorized|grant/i.test(guestRes.output);
  console.log(`admin 能用 bash 并拿到输出: ${adminGotOutput ? "✅" : "❌"}`);
  console.log(`guest 被拒绝并如实说明:     ${guestDenied ? "✅" : "❌"}`);

  const ok = adminGotOutput && guestDenied;
  console.log(ok ? "\n🎉 身份感知权限真实跑通" : "\n⚠️ 权限隔离结果不符预期");
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error("\n❌ 出错:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
