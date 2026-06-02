/**
 * basic-agent.ts
 * 框架完整能力演示示例
 * 运行方式: npx tsx examples/basic-agent.ts
 */

import {
  Framework,
  defineAgent,
  defineTool,
  defineOrchestrator,
  createWorkspace,
  EchoModelProvider,
  MemoryStorage,
  TokenCounter,
  countTokens,
  OrchestratorStrategy,
} from "../src/index.js";
import type {
  ToolDef,
  AgentDef,
  OrchestratorDef,
  WorkspaceConfig,
} from "../src/index.js";

// ============================================================
// 步骤 1: 定义 3 个工具
// ============================================================

/** 工具1: 回显 - 直接返回输入内容 */
const echoTool: ToolDef = defineTool({
  name: "echo",
  description: "回显输入的文本内容",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "要回显的文本" },
    },
    required: ["text"],
  },
  async execute(input) {
    const text = input.text as string;
    return {
      content: `[回显] ${text}`,
    };
  },
  isReadOnly: true,
  isConcurrencySafe: true,
});

/** 工具2: 获取当前时间 */
const getTimeTool: ToolDef = defineTool({
  name: "get_time",
  description: "获取当前服务器时间",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        description: "时间格式: iso | locale | timestamp",
        enum: ["iso", "locale", "timestamp"],
      },
    },
    required: [],
  },
  async execute(input) {
    const format = (input.format as string) ?? "iso";
    const now = new Date();

    let result: string;
    switch (format) {
      case "timestamp":
        result = String(now.getTime());
        break;
      case "locale":
        result = now.toLocaleString("zh-CN");
        break;
      case "iso":
      default:
        result = now.toISOString();
        break;
    }

    return {
      content: `当前时间 (${format}): ${result}`,
    };
  },
  isReadOnly: true,
  isConcurrencySafe: true,
});

/** 工具3: 生成随机数 */
const randomNumberTool: ToolDef = defineTool({
  name: "random_number",
  description: "生成指定范围内的随机整数",
  inputSchema: {
    type: "object",
    properties: {
      min: { type: "number", description: "最小值（含）", default: 1 },
      max: { type: "number", description: "最大值（含）", default: 100 },
      count: { type: "number", description: "生成个数", default: 1 },
    },
    required: [],
  },
  async execute(input) {
    const min = (input.min as number) ?? 1;
    const max = (input.max as number) ?? 100;
    const count = Math.min((input.count as number) ?? 1, 10);

    const numbers: number[] = [];
    for (let i = 0; i < count; i++) {
      numbers.push(Math.floor(Math.random() * (max - min + 1)) + min);
    }

    return {
      content: `随机数 [${min}, ${max}] x${count}: ${numbers.join(", ")}`,
    };
  },
  isReadOnly: true,
  isConcurrencySafe: true,
});

// ============================================================
// 步骤 2: 定义 Agent
// ============================================================

/** 演示用 Agent，注册了全部 3 个工具 */
const demoAgent: AgentDef = defineAgent({
  id: "demo-agent",
  name: "演示Agent",
  model: "echo",
  systemPrompt: "你是一个演示Agent，用于展示框架的基础能力。",
  tools: [echoTool, getTimeTool, randomNumberTool],
  maxTurns: 10,
});

// ============================================================
// 步骤 3: 定义编排器（用于多 Agent 协作演示）
// ============================================================

/** 顺序编排器：按顺序执行多个 Agent */
const demoOrchestrator: OrchestratorDef = defineOrchestrator({
  id: "demo-sequential",
  agents: [demoAgent],
  strategy: OrchestratorStrategy.Sequential,
});

// ============================================================
// 步骤 4: 初始化框架
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Agent Framework 能力演示          ║");
  console.log("╚══════════════════════════════════════╝\n");

  const framework = new Framework();

  // ---- 注册组件 ----
  console.log("[1] 注册组件...");

  // 注册 Model Provider (使用 Echo mock)
  framework.useModel(new EchoModelProvider("echo"));

  // 注册 Agent
  framework.useAgent(demoAgent);

  // 注册工具（独立注册，可以被多个 Agent 共享）
  framework.useTool(echoTool);
  framework.useTool(getTimeTool);
  framework.useTool(randomNumberTool);

  // 注册编排器
  framework.useOrchestrator(demoOrchestrator);

  // 注册本地沙盒工作空间
  framework.useWorkspace("local-sandbox", {
    type: "local",
    workDir: process.cwd(),
    limits: {
      timeout: 30000,
    },
  });

  // 注册存储
  const storage = new MemoryStorage();
  framework.useStorage(storage, "demo-storage");

  // 注册事件监听
  framework.on("agent:start", (event) => {
    console.log(`  📡 事件: agent:start → ${event.data.agentName}`);
  });
  framework.on("agent:end", (event) => {
    console.log(`  📡 事件: agent:end → ${event.data.agentId}`);
  });
  framework.on("orchestrator:start", (event) => {
    console.log(`  📡 事件: orchestrator:start → ${event.data.id}`);
  });
  framework.on("orchestrator:end", (event) => {
    console.log(`  📡 事件: orchestrator:end → ${event.data.id}`);
  });

  console.log("  ✅ 组件注册完成\n");

  // ---- 启动框架 ----
  console.log("[2] 启动框架...");
  await framework.start();
  console.log("  ✅ 框架已启动 (isRunning:", framework.isRunning, ")\n");

  // ---- 执行业务逻辑 ----
  console.log("[3] 执行业务逻辑...\n");

  // ---- 3a: 基本 run ----
  console.log("  ▶ 3a. 基本 run 调用:");
  const result1 = await framework.run("你好，框架！");
  console.log(`     输入: "你好，框架！"`);
  console.log(`     输出: ${result1.output}`);
  console.log(`     消息数: ${result1.messages.length}\n`);

  // ---- 3b: 带编排器的 run ----
  console.log("  ▶ 3b. 使用编排器 run:");
  const result2 = await framework.run("请处理这个任务", {
    orchestrator: "demo-sequential",
  });
  console.log(`     输入: "请处理这个任务"`);
  console.log(`     输出: ${result2.output}`);
  console.log(`     元数据: ${JSON.stringify(result2.metadata)}\n`);

  // ---- 3c: 工具调用演示 ----
  console.log("  ▶ 3c. 直接工具调用:");
  const echoResult = await echoTool.execute(
    { text: "Hello from tool!" },
    { messages: [], artifacts: {}, metadata: {} }
  );
  console.log(`     echo: ${echoResult.content}`);

  const timeResult = await getTimeTool.execute(
    { format: "locale" },
    { messages: [], artifacts: {}, metadata: {} }
  );
  console.log(`     get_time: ${timeResult.content}`);

  const randResult = await randomNumberTool.execute(
    { min: 1, max: 100, count: 5 },
    { messages: [], artifacts: {}, metadata: {} }
  );
  console.log(`     random_number: ${randResult.content}\n`);

  // ---- 3d: 工作空间演示 ----
  console.log("  ▶ 3d. 工作空间操作:");
  const ws = framework.getWorkspace("local-sandbox");
  if (ws) {
    console.log(`     状态: ${ws.status}`);
    console.log(`     类型: ${ws.config.type}`);
    console.log(`     工作目录: ${ws.config.workDir}`);
    console.log(`     是否运行: ${ws.isRunning()}\n`);
  }

  // ---- 3e: 存储演示 ----
  console.log("  ▶ 3e. 存储操作:");
  const demoStorage = framework.getStorage("demo-storage");
  if (demoStorage) {
    await demoStorage.save("demo-key", { hello: "world", timestamp: Date.now() });
    const loaded = await demoStorage.load<{ hello: string }>("demo-key");
    console.log(`     已存储 key="demo-key"`);
    console.log(`     读取结果: ${JSON.stringify(loaded)}\n`);
  }

  // ---- 3f: Token 计数演示 ----
  console.log("  ▶ 3f. Token 计数:");
  const counter = new TokenCounter("claude");

  const sampleText = "Hello World! 你好世界！这是一个演示文本。";
  const simpleTokens = countTokens(sampleText);
  const claudeTokens = counter.count(sampleText);
  const gptTokens = counter.count(sampleText, "gpt");

  console.log(`     示例文本: "${sampleText}"`);
  console.log(`     simple 估算: ${simpleTokens} tokens`);
  console.log(`     claude 估算: ${claudeTokens} tokens`);
  console.log(`     gpt   估算: ${gptTokens} tokens`);

  const usage = counter.countWithUsage(
    "用户输入: 请帮我分析这段代码",
    "助手回复: 这是一段测试代码，功能是..."
  );
  console.log(`     用量统计: 输入=${usage.inputTokens}, 输出=${usage.outputTokens}, 总计=${usage.total}\n`);

  // ---- 3g: 查询已注册组件 ----
  console.log("  ▶ 3g. 查询已注册组件:");
  console.log(`     已注册 Agent: ${framework.getAgent("demo-agent")?.name ?? "无"}`);
  console.log(`     已注册 Tool (echo): ${framework.getTool("echo")?.name ?? "无"}`);
  console.log(`     已注册 Tool (get_time): ${framework.getTool("get_time")?.name ?? "无"}`);
  console.log(`     已注册 Tool (random_number): ${framework.getTool("random_number")?.name ?? "无"}`);
  console.log(`     已注册 Model: ${framework.getModel("echo")?.id ?? "无"}`);
  console.log(`     已注册 编排器: ${framework.getOrchestrator("demo-sequential")?.id ?? "无"}`);
  console.log(`     已注册 工作空间: ${framework.getWorkspace("local-sandbox") ? "存在" : "无"}`);
  console.log(`     已注册 存储: ${framework.getStorage("demo-storage") ? "存在" : "无"}`);
  console.log(`     MCP 管理器: ${framework.getMCPManager() ? "已初始化" : "未使用"}\n`);

  // ---- 停止框架 ----
  console.log("[4] 停止框架...");
  await framework.stop();
  console.log("  ✅ 框架已停止\n");

  console.log("══════════════════════════════════════");
  console.log("  演示完成！所有功能正常运行 ✅");
  console.log("══════════════════════════════════════");
}

// 运行主函数
main().catch((error) => {
  console.error("❌ 演示执行失败:", error);
  process.exit(1);
});
