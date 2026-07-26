/**
 * 简化版 Multi-Agent 测试
 * 用于验证框架基本功能
 */

import {
  Framework,
  defineAgent,
  defineTool,
  EchoModelProvider,
} from "../src/index.js";

// 简单工具
const echoTool = defineTool({
  name: "echo",
  description: "回显输入",
  inputSchema: { text: { type: "string" } },
  async execute(input) {
    const text = (input.text as string) || "hello";
    return { content: `Echo: ${text}` };
  },
  isReadOnly: true,
});

// 简单 Agent
const simpleAgent = defineAgent({
  id: "simple-agent",
  name: "Simple Agent",
  model: "echo",
  systemPrompt: "你是一个简单的助手",
  tools: [echoTool],
});

async function main() {
  console.log("\n🧪 简单 Multi-Agent 测试\n");

  const framework = new Framework();
  framework.useModel(new EchoModelProvider("echo"));
  framework.useAgent(simpleAgent);
  framework.useTool(echoTool);

  await framework.start();

  console.log("▶️  运行简单任务...");
  const result = await framework.run("Hello World!");
  console.log("✅ 结果:", result.output);

  await framework.stop();
  console.log("\n🏁 测试完成");
}

main().catch(console.error);
