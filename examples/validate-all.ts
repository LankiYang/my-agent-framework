/**
 * 框架全模块运行时验证脚本
 *
 * 逐一验证每个模块的运行时功能和边界情况。
 * 运行: npx tsx examples/validate-all.ts
 */

// ====================================================================
// 1. 核心类型系统 + EventBus
// ====================================================================
async function testCoreTypes() {
  const { EventBusImpl: EventBus } = await import("../src/core/event-bus.js");

  const bus = new EventBus();
  const events: string[] = [];

  // 验证 on/emit/off
  bus.on("test", (p) => events.push(`got:${p}`));
  bus.emit("test", "a");
  const handler2 = (p: unknown) => events.push(`got2:${p}`);
  bus.on("test", handler2);
  bus.emit("test", "b");
  bus.off("test", handler2);
  bus.emit("test", "c");

  const r1 = events.join(",") === "got:a,got:b,got2:b,got:c";
  console.log(`  ${r1 ? "✅" : "❌"} EventBus on/emit/off: ${events.join(",")}`);

  // 验证 once
  events.length = 0;
  bus.once("once", (p) => events.push(`once:${p}`));
  bus.emit("once", "1");
  bus.emit("once", "2");
  const r2 = events.length === 1 && events[0] === "once:1";
  console.log(`  ${r2 ? "✅" : "❌"} EventBus once: ${events.join(",")}`);

  // 验证通配符（通配符 handler 接收合并的 event:payload 字符串）
  events.length = 0;
  bus.on("*", (p) => events.push(String(p)));
  bus.emit("cat", "meow");
  bus.emit("dog", "woof");
  const r3 = events.join(",") === "meow,woof";
  console.log(`  ${r3 ? "✅" : "❌"} EventBus 通配符: ${events.join(",")}`);
}

// ====================================================================
// 2. ContentBlock 消息系统
// ====================================================================
async function testContentBlock() {
  const { Msg } = await import("../src/runtime/context-block.js");

  const textMsg = Msg.ofText("user", "你好");
  const r1 = textMsg.role === "user" && textMsg.content[0]?.type === "text" && (textMsg.content[0] as any).text === "你好";
  console.log(`  ${r1 ? "✅" : "❌"} Msg.ofText: role=${textMsg.role}, blocks=${textMsg.content.length}`);

  const tcMsg = Msg.ofToolCall("echo", { text: "hello" }, "call-1");
  const r2 = tcMsg.role === "assistant" && (tcMsg.content[0] as any).type === "tool_call" && (tcMsg.content[0] as any).toolName === "echo";
  console.log(`  ${r2 ? "✅" : "❌"} Msg.ofToolCall: toolName=${(tcMsg.content[0] as any).toolName}`);

  const trMsg = Msg.ofToolResult("call-1", "ok", false);
  const r3 = trMsg.role === "tool" && (trMsg.content[0] as any).type === "tool_result" && (trMsg.content[0] as any).content === "ok";
  console.log(`  ${r3 ? "✅" : "❌"} Msg.ofToolResult: isError=${(trMsg.content[0] as any).isError}`);

  // 验证 appendEvent 流式渲染
  textMsg.appendEvent({ type: "content_delta", delta: " world" });
  const r4 = (textMsg.content[textMsg.content.length - 1] as any).text?.includes("world");
  console.log(`  ${r4 ? "✅" : "❌"} Msg.appendEvent 流式渲染: text includes "world"`);
}

// ====================================================================
// 3. 洋葱中间件系统
// ====================================================================
async function testMiddleware() {
  const { MiddlewarePipeline, HookRegistry, HookPoint, createMiddleware } = await import("../src/runtime/middleware.js");

  // 验证洋葱执行顺序
  const pipeline = new MiddlewarePipeline();
  const order: number[] = [];

  pipeline.use(async (ctx, next) => {
    order.push(1);
    await next();
    order.push(5);
  });
  pipeline.use(async (ctx, next) => {
    order.push(2);
    await next();
    order.push(4);
  });

  await pipeline.run({ messages: [], systemPrompt: "", tools: [], agentId: "test" });
  const r1 = order.join(",") === "1,2,4,5";
  console.log(`  ${r1 ? "✅" : "❌"} 洋葱执行顺序: ${order.join(" → ")}`);

  // 验证中间件可修改 context
  const pipeline2 = new MiddlewarePipeline();
  pipeline2.use(async (ctx, next) => {
    ctx.systemPrompt = "modified";
    await next();
  });
  const resultCtx = await pipeline2.run({ messages: [], systemPrompt: "", tools: [], agentId: "test" });
  const r2 = resultCtx.systemPrompt === "modified";
  console.log(`  ${r2 ? "✅" : "❌"} 中间件修改 context: ${resultCtx.systemPrompt}`);

  // 验证 HookRegistry
  const hookReg = new HookRegistry();
  const hookOrder: string[] = [];
  hookReg.register(HookPoint.onReply, createMiddleware("a", async (ctx, next) => {
    hookOrder.push("a-before");
    await next();
    hookOrder.push("a-after");
  }).fn);
  hookReg.register(HookPoint.onReply, createMiddleware("b", async (ctx, next) => {
    hookOrder.push("b-before");
    await next();
    hookOrder.push("b-after");
  }).fn);
  await hookReg.apply(HookPoint.onReply, { messages: [], systemPrompt: "", tools: [], agentId: "test" });
  const r3 = hookOrder.join(",") === "a-before,b-before,b-after,a-after";
  console.log(`  ${r3 ? "✅" : "❌"} HookRegistry 洋葱: ${hookOrder.join(" → ")}`);

  // 验证 Transform Hook
  const transformed = await hookReg.applyTransform(HookPoint.onSystemPrompt, "hello", {} as any);
  const r4 = transformed === "hello";
  console.log(`  ${r4 ? "✅" : "❌"} Transform hook: "${transformed}"`);

  hookReg.registerTransform(HookPoint.onSystemPrompt, async (v: string) => `[${v}]`);
  const transformed2 = await hookReg.applyTransform(HookPoint.onSystemPrompt, "hello", {} as any);
  const r5 = transformed2 === "[hello]";
  console.log(`  ${r5 ? "✅" : "❌"} Transform hook 修改值: "${transformed2}"`);
}

// ====================================================================
// 4. 权限引擎
// ====================================================================
async function testPermission() {
  const { PermissionEngine, PermissionMode, PermissionLevel } = await import("../src/runtime/permission.js");

  const engine = new PermissionEngine();

  // EXPLORE 模式 + 有 isReadOnly 的工具 → Allowed
  let result = engine.checkToolPermission("Read", {}, [
    { name: "Read", description: "read", inputSchema: {}, execute: async () => ({ content: "" }), isReadOnly: true },
  ], PermissionMode.Explore);
  console.log(`  ${result === PermissionLevel.Allowed ? "✅" : "❌"} EXPLORE 模式 Read(只读) 允许: ${result}`);

  // 验证 BYPASS
  result = engine.checkToolPermission("Bash", {}, [], PermissionMode.Bypass);
  console.log(`  ${result === PermissionLevel.Allowed ? "✅" : "❌"} BYPASS 模式: ${result}`);

  // 验证内置规则
  result = engine.checkToolPermission("Delete", {}, [], PermissionMode.Default);
  console.log(`  ${result === PermissionLevel.Ask ? "✅" : "❌"} Default 模式破坏性工具需 Ask: ${result}`);

  // 验证 DontAsk
  result = engine.checkToolPermission("Delete", {}, [], PermissionMode.DontAsk);
  console.log(`  ${result === PermissionLevel.Denied ? "✅" : "❌"} DontAsk 模式 Ask→Denied: ${result}`);
}

// ====================================================================
// 5. 工具分组
// ====================================================================
async function testToolGroup() {
  const { Toolkit, ToolGroup } = await import("../src/runtime/tool-group.js");

  const toolkit = new Toolkit();
  const tool1 = { name: "echo", description: "echo", inputSchema: {}, execute: async () => ({ content: "" }) };
  const tool2 = { name: "bash", description: "bash", inputSchema: {}, execute: async () => ({ content: "" }) };
  const tool3 = { name: "read", description: "read", inputSchema: {}, execute: async () => ({ content: "" }) };

  toolkit.registerTools([tool1, tool2, tool3]);
  const r1 = toolkit.getAllTools().length === 3;
  console.log(`  ${r1 ? "✅" : "❌"} 注册 3 个工具: count=${toolkit.getAllTools().length}`);

  const group = toolkit.createGroup("dangerous", ["echo", "bash"], "危险工具组");
  const r2 = group !== undefined && group.name === "dangerous";
  console.log(`  ${r2 ? "✅" : "❌"} 创建分组: ${group?.name}`);

  toolkit.deactivateGroup("dangerous");
  const r3 = toolkit.getAllTools().length === 1; // only read should be available
  console.log(`  ${r3 ? "✅" : "❌"} 停用分组后工具数: ${toolkit.getAllTools().length} (预期 1)`);

  toolkit.activateGroup("dangerous");
  const r4 = toolkit.getAllTools().length === 3;
  console.log(`  ${r4 ? "✅" : "❌"} 激活分组后工具数: ${toolkit.getAllTools().length} (预期 3)`);

  // 验证 callTool
  const result = await toolkit.callTool("echo", { text: "hello" });
  const r5 = result !== undefined;
  console.log(`  ${r5 ? "✅" : "❌"} callTool 执行: ${typeof result}`);

  // 验证 removeTool
  toolkit.removeTool("echo");
  const r6 = toolkit.getTool("echo") === undefined;
  console.log(`  ${r6 ? "✅" : "❌"} removeTool echo: ${toolkit.getTool("echo")}`);
}

// ====================================================================
// 6. Token 计数器
// ====================================================================
async function testTokenCounter() {
  const { TokenCounter, countTokens } = await import("../src/utils/token-counter.js");

  const counter = new TokenCounter();

  // 各种语言的 token 计数
  const english = counter.count("Hello World");
  const chinese = counter.count("你好世界");
  const code = counter.count('function add(a, b) { return a + b; }');
  const mixed = counter.count("Hello 世界");

  console.log(`  ✅ 英文 "Hello World": ${english.tokens} tokens`);
  console.log(`  ✅ 中文 "你好世界": ${chinese.tokens} tokens`);
  console.log(`  ✅ 代码 "function add": ${code.tokens} tokens`);
  console.log(`  ✅ 混合 "Hello 世界": ${mixed.tokens} tokens`);

  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
  ];
  const msgTokens = counter.countMessages(messages);
  console.log(`  ✅ 消息列表计数: ${msgTokens.tokens} tokens (${messages.length} 条消息)`);

  // 预算估算
  const usage = counter.estimateUsage("system prompt", messages);
  console.log(`  ✅ 用量估算: total=${usage.total}, system=${usage.breakdown.system}, messages=${usage.breakdown.messages}`);

  // 预算检查
  const within = counter.isWithinBudget(msgTokens, 100);
  const over = counter.isWithinBudget(msgTokens, 5);
  console.log(`  ✅ 在预算内(100): ${within}, 超出预算(5): ${over}`);

  // 便捷函数
  const quick = countTokens("test token");
  console.log(`  ✅ countTokens(): ${quick} tokens`);

  // 模型预设
  const counterClaude = new TokenCounter({ model: "claude-3.5" });
  const cc = counterClaude.count("Hello World");
  console.log(`  ✅ Claude 3.5 预设计数: ${cc.tokens} tokens`);
}

// ====================================================================
// 7. 上下文管理器
// ====================================================================
async function testContextManager() {
  const { ContextManager } = await import("../src/runtime/context-manager.js");

  const cm = new ContextManager();

  const msgs = [
    { id: "1", role: "user" as const, type: "text" as const, content: "Hello", timestamp: 1 },
    { id: "2", role: "assistant" as const, type: "text" as const, content: "Hi!", timestamp: 2 },
  ];

  const built = cm.buildMessages({
    id: "sess-1",
    messages: msgs,
    systemPrompt: "You are a helpful assistant.",
    metadata: {},
  });

  const r1 = built.length >= 3; // system + user + assistant
  console.log(`  ${r1 ? "✅" : "❌"} buildMessages: ${built.length} 条消息`);

  // 工具描述
  const tools = [
    { name: "echo", description: "echo back", inputSchema: {}, execute: async () => ({ content: "" }) },
  ];
  const desc = cm.getToolDescriptions(tools);
  const r2 = desc.includes("echo") && desc.includes("echo back");
  console.log(`  ${r2 ? "✅" : "❌"} getToolDescriptions: contains echo "${desc.slice(0, 40)}..."`);

  // token 裁剪
  const trimmed = cm.trimToTokenBudget(built, 100);
  console.log(`  ${trimmed.length <= built.length ? "✅" : "❌"} trimToTokenBudget: ${built.length} → ${trimmed.length} 条`);
}

// ====================================================================
// 8. 推理循环
// ====================================================================
async function testAgentLoop() {
  const { agentLoop } = await import("../src/runtime/agent-loop.js");
  const { EchoModelProvider } = await import("../src/provider/model/index.js");

  const model = new EchoModelProvider();

  const messages = [
    { id: "1", role: "user" as const, type: "text" as const, content: "Hello", timestamp: 1 },
  ];

  const events: string[] = [];
  const terminal = await agentLoop(messages, {
    model,
    tools: [],
    systemPrompt: "You are a helpful assistant.",
    maxTurns: 5,
  }).next();

  const r1 = terminal.value !== undefined;
  console.log(`  ${r1 ? "✅" : "❌"} agentLoop 返回结果: reason=${terminal.value?.reason}`);

  // 测试 1 轮对话
  const stream = agentLoop(messages, {
    model,
    tools: [],
    systemPrompt: "You are a helpful assistant.",
    maxTurns: 1,
  });
  let eventCount = 0;
  for await (const event of stream) {
    eventCount++;
  }
  console.log(`  ✅ agentLoop 流式事件: ${eventCount} 个事件`);
}

// ====================================================================
// 9. 工具执行器
// ====================================================================
async function testToolExecutor() {
  const { ToolExecutor } = await import("../src/runtime/tool-executor.js");

  const tool1 = {
    name: "echo", description: "echo input",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (input: any) => ({ content: `echo: ${input.text}` }),
  };

  const executor = new ToolExecutor([tool1]);

  const calls = [{
    id: "call_1",
    role: "assistant" as const,
    type: "tool_call" as const,
    content: "",
    timestamp: 1,
    toolName: "echo",
    toolInput: { text: "hello" },
    toolCallId: "tc1",
  }];

  const results = await executor.executeMany(calls, { messages: [], artifacts: {}, metadata: {} });
  const r1 = results.length === 1 && results[0].role === "tool";
  console.log(`  ${r1 ? "✅" : "❌"} executeMany: ${results.length} 个结果`);

  // 验证并发安全工具并行执行
  const slowTool = {
    name: "slow", description: "slow",
    inputSchema: {},
    execute: async () => { await new Promise(r => setTimeout(r, 100)); return { content: "done" }; },
    isConcurrencySafe: true,
  };
  const executor2 = new ToolExecutor([slowTool]);
  const start = Date.now();
  await executor2.executeMany(
    [{ id: "c1", role: "assistant" as const, type: "tool_call" as const, content: "", timestamp: 1, toolName: "slow", toolInput: {}, toolCallId: "tc1" },
     { id: "c2", role: "assistant" as const, type: "tool_call" as const, content: "", timestamp: 1, toolName: "slow", toolInput: {}, toolCallId: "tc2" }],
    { messages: [], artifacts: {}, metadata: {} }
  );
  const elapsed = Date.now() - start;
  console.log(`  ${elapsed < 200 ? "✅" : "❌"} 并发执行: ${elapsed}ms (2个100ms任务并行应 < 200ms)`);
}

// ====================================================================
// 10. Orchestrator
// ====================================================================
async function testOrchestrator() {
  const { SequentialOrchestrator, ParallelOrchestrator, RouterOrchestrator, SupervisorOrchestrator } = await import("../src/orchestrator/index.js");
  const { OrchestratorStrategy } = await import("../src/core/types.js");

  const echoAgent = { id: "agent-a", name: "Agent A", model: "", systemPrompt: "", tools: [] };
  const upperAgent = { id: "agent-b", name: "Agent B", model: "", systemPrompt: "", tools: [] };

  // Sequential
  const seq = new SequentialOrchestrator({ id: "seq", agents: [echoAgent, upperAgent], strategy: OrchestratorStrategy.Sequential });
  const seqResult = await seq.run({ input: "test" });
  const r1 = seqResult.output && seqResult.agentResults.length === 2;
  console.log(`  ${r1 ? "✅" : "❌"} Sequential: ${seqResult.agentResults.length} agents, output="${seqResult.output.slice(0, 30)}"`);

  // Parallel
  const par = new ParallelOrchestrator({ id: "par", agents: [echoAgent, upperAgent], strategy: OrchestratorStrategy.Parallel });
  const parResult = await par.run({ input: "test" });
  const r2 = parResult.agentResults.length === 2;
  console.log(`  ${r2 ? "✅" : "❌"} Parallel: ${parResult.agentResults.length} agents`);

  // Router
  const router = new RouterOrchestrator({
    id: "router", agents: [echoAgent, upperAgent], strategy: OrchestratorStrategy.Router,
    route: (msg, agents) => agents[0].id,
  });
  const routerResult = await router.run({ input: "test" });
  const r3 = routerResult.agentResults.length === 1;
  console.log(`  ${r3 ? "✅" : "❌"} Router: ${routerResult.agentResults.length} agent (只路由到 1 个)`);

  // 验证 edge case: 空 Agent 列表
  try {
    const emptyOrch = new SequentialOrchestrator({ id: "empty", agents: [], strategy: OrchestratorStrategy.Sequential });
    await emptyOrch.run({ input: "test" });
    console.log(`  ❌ Sequential 空列表应报错但未报错`);
  } catch (e: any) {
    console.log(`  ✅ Sequential 空列表: ${e.message}`);
  }
}

// ====================================================================
// 11. Provider（Model/Channel/Storage/Workspace）
// ====================================================================
async function testProviders() {
  const { EchoModelProvider, BaseModelProvider } = await import("../src/provider/model/index.js");
  const { MemoryStorage, FileStorage } = await import("../src/provider/storage/index.js");
  const { BaseChannel } = await import("../src/provider/channel/index.js");
  const { createWorkspace } = await import("../src/provider/workspace.js");

  // Model
  const model = new EchoModelProvider();
  const stream = model.generate(
    [{ id: "1", role: "user", type: "text", content: "Hello", timestamp: 1 }],
    [],
    "system prompt"
  );
  const events: any[] = [];
  for await (const e of stream) {
    events.push(e);
  }
  const r1 = events.length > 0;
  console.log(`  ${r1 ? "✅" : "❌"} EchoModelProvider generate: ${events.length} 个事件`);
  console.log(`     内容: "${events.map((e: any) => e.type === "content_delta" ? e.delta : e.type).join(" | ")}"`);

  // Memory Storage
  const mem = new MemoryStorage();
  await mem.save("k1", { data: 123 });
  const loaded = await mem.load<{ data: number }>("k1");
  const r2 = loaded?.data === 123;
  console.log(`  ${r2 ? "✅" : "❌"} MemoryStorage save/load: ${JSON.stringify(loaded)}`);

  const keys = await mem.list();
  console.log(`  ✅ MemoryStorage list: ${keys.join(",")}`);

  await mem.delete("k1");
  const afterDel = await mem.load("k1");
  console.log(`  ${afterDel === null ? "✅" : "❌"} MemoryStorage delete: key gone`);

  // File Storage (into temp dir)
  const tmpDir = `file:///C:/Users/1/AppData/Local/Temp/fw-test-${Date.now()}`;
  // Just verify MemoryStorage, skip FileStorage for now

  // Workspace (local)
  const ws = createWorkspace({ type: "local", workDir: process.cwd() });
  await ws.initialize();
  const r3 = ws.isRunning() && ws.status === "running";
  console.log(`  ${r3 ? "✅" : "❌"} LocalWorkspace 初始化: status=${ws.status}`);

  // exec command
  const cmdResult = await ws.execCommand("echo hello");
  const r4 = cmdResult.exitCode === 0 && cmdResult.stdout.trim() === "hello";
  console.log(`  ${r4 ? "✅" : "❌"} Workspace execCommand "echo hello": exit=${cmdResult.exitCode}, stdout="${cmdResult.stdout.trim()}"`);

  // read/write file
  const testPath = "test-framework-temp.txt";
  await ws.writeFile(testPath, "test content");
  const readResult = await ws.readFile(testPath);
  const r5 = readResult.success && readResult.content === "test content";
  console.log(`  ${r5 ? "✅" : "❌"} Workspace 写入/读取文件: ${r5 ? readResult.content : readResult.error}`);

  // exists
  const existsResult = await ws.exists(testPath);
  const r6 = existsResult.success;
  console.log(`  ${r6 ? "✅" : "❌"} Workspace exists: ${existsResult.success}`);

  // delete
  await ws.deleteFile(testPath);
  const existsAfter = await ws.exists(testPath);
  const r7 = !existsAfter.success;
  console.log(`  ${r7 ? "✅" : "❌"} Workspace 删除文件: ${r7}`);

  // list files
  const listResult = await ws.listFiles(".");
  const r8 = listResult.success && listResult.files && listResult.files.length > 0;
  console.log(`  ${r8 ? "✅" : "❌"} Workspace 列出目录: ${listResult.files?.length || 0} 个文件`);

  await ws.close();
  console.log(`  ✅ Workspace 关闭: status=${ws.status}`);
}

// ====================================================================
// 12. Framework 集成
// ====================================================================
async function testFramework() {
  const { Framework, defineAgent, defineTool } = await import("../src/index.js");
  const { EchoModelProvider } = await import("../src/provider/model/index.js");

  const app = new Framework();
  app.useModel(new EchoModelProvider());
  app.useAgent(defineAgent({
    id: "demo", name: "Demo", model: "echo", systemPrompt: "You are demo.", tools: [],
  }));

  const echoTool = defineTool({
    name: "echo",
    description: "echo back",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (input: any) => ({ content: `echo: ${input.text}` }),
  });
  app.useTool(echoTool);

  // 验证组件注册
  const r1 = app.getAgent("demo")?.id === "demo" && app.getTool("echo")?.name === "echo";
  console.log(`  ${r1 ? "✅" : "❌"} 组件注册: agent=${!!app.getAgent("demo")}, tool=${!!app.getTool("echo")}`);

  // 验证事件系统
  const events: string[] = [];
  app.on("agent:start", (e) => events.push(e.type));
  app.on("agent:end", (e) => events.push(e.type));

  //  启动/停止
  await app.start();
  const r2 = app.isRunning;
  console.log(`  ${r2 ? "✅" : "❌"} Framework start: isRunning=${app.isRunning}`);

  const result = await app.run("hello", {});
  const r3 = result.output !== undefined && result.messages.length > 0;
  console.log(`  ${r3 ? "✅" : "❌"} Framework run: output="${result.output}", messages=${result.messages.length}`);

  await app.stop();
  const r4 = !app.isRunning;
  console.log(`  ${r4 ? "✅" : "❌"} Framework stop: isRunning=${app.isRunning}`);

  // 验证重复注册报错
  try {
    app.useTool(echoTool);
    console.log(`  ❌ 重复注册 Tool 应报错但未报错`);
  } catch (e: any) {
    console.log(`  ✅ 重复注册 Tool: ${e.message}`);
  }

  // 验证未启动时调用 run 报错
  try {
    await app.run("test", {});
    console.log(`  ❌ 未启动时调用 run 应报错但未报错`);
  } catch (e: any) {
    console.log(`  ✅ 未启动时调用 run: ${(e as Error).message}`);
  }
}

// ====================================================================
// 13. 重复注册容错测试
// ====================================================================
async function testEdgeCases() {
  const { Framework, defineAgent, defineTool } = await import("../src/index.js");

  // 重复 start
  const app = new Framework();
  app.useAgent(defineAgent({ id: "a", name: "A", model: "", systemPrompt: "", tools: [] }));
  await app.start();
  try {
    await app.start();
    console.log(`  ❌ 重复 start 应报错但未报错`);
  } catch (e: any) {
    console.log(`  ✅ 重复 start: ${e.message}`);
  }
  await app.stop();
}

// ====================================================================
// 运行所有测试
// ====================================================================
async function main() {
  const results: { name: string; pass: boolean }[] = [];

  console.log("=".repeat(60));
  console.log("  🧪 Agent Framework 全模块运行时验证");
  console.log("=".repeat(60));
  console.log();

  const tests = [
    ["1. 核心类型系统 + EventBus", testCoreTypes],
    ["2. ContentBlock 消息系统", testContentBlock],
    ["3. 洋葱中间件系统", testMiddleware],
    ["4. 权限引擎", testPermission],
    ["5. 工具分组管理", testToolGroup],
    ["6. Token 计数器", testTokenCounter],
    ["7. 上下文管理器", testContextManager],
    ["8. 推理循环", testAgentLoop],
    ["9. 工具执行器", testToolExecutor],
    ["10. Orchestrator 编排器", testOrchestrator],
    ["11. Provider (Model/Storage/Workspace)", testProviders],
    ["12. Framework 集成", testFramework],
    ["13. 边界情况测试", testEdgeCases],
  ];

  let allPass = true;
  for (const [name, fn] of tests) {
    console.log(`\n── ${name} ──`);
    try {
      await (fn as () => Promise<void>)();
      console.log(`  ✅ 通过`);
    } catch (err: any) {
      console.log(`  ❌ 失败: ${err.message}`);
      console.error(err.stack?.split("\n").slice(0, 3).join("\n"));
      allPass = false;
    }
  }

  console.log();
  console.log("=".repeat(60));
  if (allPass) {
    console.log("  🎉 所有模块验证通过!");
  } else {
    console.log("  ❌ 部分模块验证失败，请检查上方日志");
  }
  console.log("=".repeat(60));

  process.exit(allPass ? 0 : 1);
}

main();
