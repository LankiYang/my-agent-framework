/**
 * Multi-Agent 任务自动拆解与并行执行系统
 *
 * 功能：
 * 1. 任务拆解 Agent - 将复杂任务自动拆分为多个可并行的子任务
 * 2. 并行协调器 - 同时执行多个子任务，汇总结果
 * 3. 结果整合 Agent - 将并行结果整合为最终输出
 */

import {
  Framework,
  createTool,
  createAgent,
  defineAgent,
  defineTool,
  EchoModelProvider,
  OrchestratorStrategy,
} from "../src/index.js";
import type {
  AgentDef,
  ToolDef,
  Message,
  AgentResult,
  OrchestratorResult,
  SharedContext,
} from "../src/index.js";

// ============================================================
// 第一步：定义通用工具
// ============================================================

/**
 * 工具1：文本分析工具
 */
const textAnalyzer = defineTool({
  name: "text_analyzer",
  description: "分析文本内容，提取关键信息",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      mode: { type: "string", enum: ["summary", "keywords", "sentiment"] },
    },
    required: ["text"],
  },
  async execute(input, context) {
    const text = input.text as string;
    const mode = (input.mode as string) || "summary";
    
    await simulateDelay(300);

    let result;
    switch (mode) {
      case "keywords":
        result = {
          content: `文本关键词: ${extractKeywords(text).join(", ")}`,
          artifacts: { keywords: extractKeywords(text) },
        };
        break;
      case "sentiment":
        const sentiment = analyzeSentiment(text);
        result = {
          content: `情感分析结果: ${sentiment}`,
          artifacts: { sentiment },
        };
        break;
      case "summary":
      default:
        result = {
          content: `文本摘要（${text.length} 字符）: ${text.slice(0, 50)}...`,
          artifacts: { length: text.length },
        };
    }
    
    console.log(`[text_analyzer] 执行完成 (mode=${mode})`);
    return result;
  },
  isReadOnly: true,
});

/**
 * 工具2：代码处理工具
 */
const codeProcessor = defineTool({
  name: "code_processor",
  description: "处理代码相关任务（生成、分析、修复）",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", enum: ["generate", "analyze", "fix"] },
      language: { type: "string" },
      requirement: { type: "string" },
    },
    required: ["task", "requirement"],
  },
  async execute(input, context) {
    const task = input.task as string;
    const lang = (input.language as string) || "javascript";
    const requirement = input.requirement as string;
    
    await simulateDelay(400);

    let result;
    switch (task) {
      case "generate":
        result = {
          content: `生成 ${lang} 代码: ${generateSampleCode(lang, requirement)}`,
          artifacts: { language: lang },
        };
        break;
      case "analyze":
        result = {
          content: `分析代码: 代码复杂度评估: 中等, 无明显问题`,
          artifacts: { complexity: "medium" },
        };
        break;
      case "fix":
        result = {
          content: `修复代码建议: 已添加错误处理和类型检查`,
          artifacts: { fixes: 3 },
        };
        break;
    }

    console.log(`[code_processor] 执行完成 (task=${task})`);
    return result;
  },
  isReadOnly: true,
});

/**
 * 工具3：计算/数据处理工具
 */
const dataCalculator = defineTool({
  name: "data_calculator",
  description: "执行数据计算、统计、转换",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["sum", "avg", "count", "transform"] },
      data: { type: "string" },
    },
    required: ["operation"],
  },
  async execute(input, context) {
    const operation = input.operation as string;
    const data = (input.data as string) || "1,2,3,4,5";
    
    await simulateDelay(250);

    const numbers = data.split(",").map((n) => parseFloat(n.trim())).filter((n) => !isNaN(n));

    let result;
    switch (operation) {
      case "sum":
        result = { content: `求和结果: ${numbers.reduce((a, b) => a + b, 0)}` };
        break;
      case "avg":
        result = { content: `平均值: ${(numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(2)}` };
        break;
      case "count":
        result = { content: `统计结果: 共 ${numbers.length} 个数据点` };
        break;
      case "transform":
        result = { content: `转换结果: ${numbers.map((n) => n * 2).join(", ")}` };
        break;
    }

    console.log(`[data_calculator] 执行完成 (operation=${operation})`);
    return result;
  },
  isReadOnly: true,
});

// ============================================================
// 第二步：定义核心 Agent
// ============================================================

/**
 * Agent 1：任务拆解大师
 * 负责将复杂任务自动拆解为可并行的子任务
 */
const taskDecomposer = defineAgent({
  id: "task-decomposer",
  name: "任务拆解大师",
  model: "echo",
  systemPrompt: `你是专业的任务拆解专家。
你的职责：
1. 分析用户输入的复杂任务
2. 拆分为 2-5 个可以并行执行的独立子任务
3. 每个子任务包含：
   - taskId: 唯一标识
   - description: 子任务描述
   - agentType: 分配给哪种类型的 Agent (analyzer, coder, calculator)
   - priority: 优先级 (1-5)

请以 JSON 格式返回，格式示例:
{
  "subtasks": [
    {
      "taskId": "t1",
      "description": "分析用户需求",
      "agentType": "analyzer",
      "priority": 1
    }
  ]
}
`,
  tools: [textAnalyzer],
  maxTurns: 3,
});

/**
 * Agent 2：文本分析专家
 */
const textAnalyst = defineAgent({
  id: "text-analyst",
  name: "文本分析专家",
  model: "echo",
  systemPrompt: `你是专业的文本分析专家。擅长：
- 文本摘要和关键词提取
- 情感分析
- 内容分类
- 结构化信息提取

请使用可用的工具来完成任务。`,
  tools: [textAnalyzer],
  maxTurns: 5,
});

/**
 * Agent 3：代码工程师
 */
const codeEngineer = defineAgent({
  id: "code-engineer",
  name: "代码工程师",
  model: "echo",
  systemPrompt: `你是专业的代码工程师。擅长：
- 代码生成
- 代码分析
- Bug 修复
- 代码优化

请使用可用的工具来完成任务。`,
  tools: [codeProcessor],
  maxTurns: 5,
});

/**
 * Agent 4：数据科学家
 */
const dataScientist = defineAgent({
  id: "data-scientist",
  name: "数据科学家",
  model: "echo",
  systemPrompt: `你是专业的数据科学家。擅长：
- 数值计算
- 统计分析
- 数据转换
- 趋势预测

请使用可用的工具来完成任务。`,
  tools: [dataCalculator],
  maxTurns: 5,
});

/**
 * Agent 5：结果整合者
 * 负责将并行结果整合为最终输出
 */
const resultIntegrator = defineAgent({
  id: "result-integrator",
  name: "结果整合者",
  model: "echo",
  systemPrompt: `你是专业的结果整合专家。
你的职责：
1. 接收多个子任务的并行执行结果
2. 分析各结果之间的关系
3. 整合成结构清晰的完整输出
4. 为最终用户提供友好的总结

输出格式：
# 任务完成总结
## 子任务执行概况
- [结果1]
- [结果2]
## 整合结论
[最终总结]
`,
  tools: [],
  maxTurns: 3,
});

// ============================================================
// 第三步：自定义并行任务协调器
// ============================================================

/**
 * 子任务结构
 */
interface Subtask {
  taskId: string;
  description: string;
  agentType: string;
  priority: number;
}

/**
 * 任务拆解输出
 */
interface DecompositionResult {
  subtasks: Subtask[];
}

/**
 * 并行任务协调器
 */
class ParallelTaskCoordinator {
  private framework: Framework;
  private agentMap: Map<string, AgentDef>;
  private results: Map<string, AgentResult> = new Map();

  constructor(framework: Framework, specializedAgents: AgentDef[]) {
    this.framework = framework;
    this.agentMap = new Map(
      specializedAgents.map((agent) => [agent.id, agent])
    );
  }

  /**
   * 解析任务拆解结果
   */
  parseDecomposition(decomposerOutput: string): Subtask[] {
    try {
      // 尝试从输出中提取 JSON
      const jsonMatch = decomposerOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as DecompositionResult;
        return parsed.subtasks || [];
      }
    } catch (e) {
      console.warn("解析任务拆解失败，使用默认策略");
    }

    // 降级策略：创建默认子任务
    return [
      { taskId: "t1", description: decomposerOutput, agentType: "text-analyst", priority: 1 },
    ];
  }

  /**
   * 根据 agentType 找到匹配的 Agent
   */
  getAgentForSubtask(subtask: Subtask): AgentDef | undefined {
    const typeMap: Record<string, string> = {
      "analyzer": "text-analyst",
      "coder": "code-engineer",
      "calculator": "data-scientist",
    };
    
    const agentId = typeMap[subtask.agentType] || subtask.agentType;
    return this.agentMap.get(agentId);
  }

  /**
   * 执行所有子任务（并行）
   */
  async executeSubtasks(subtasks: Subtask[]): Promise<Map<string, AgentResult>> {
    console.log(`\n🚀 开始并行执行 ${subtasks.length} 个子任务...`);
    
    const executionPromises = subtasks.map(async (subtask) => {
      const agent = this.getAgentForSubtask(subtask);
      if (!agent) {
        console.warn(`⚠️ 未找到匹配 Agent，跳过: ${subtask.taskId}`);
        return null;
      }

      console.log(`  → [${subtask.taskId}] 分配给: ${agent.name}`);

      const result = await this.framework.run(subtask.description, {
        agent: agent.id,       // ← 显式指定目标 Agent（A1 修复后生效）
        context: {
          taskId: subtask.taskId,
          originalTask: subtask.description,
        },
      });

      this.results.set(subtask.taskId, result);
      console.log(`  ✓ [${subtask.taskId}] ${agent.name} 完成`);
      
      return { taskId: subtask.taskId, result };
    });

    await Promise.all(executionPromises);
    return this.results;
  }

  /**
   * 整合所有结果
   */
  async integrateResults(results: Map<string, AgentResult>): Promise<string> {
    console.log("\n📦 开始结果整合...");
    
    const resultTexts: string[] = [];
    results.forEach((result, taskId) => {
      resultTexts.push(`## [${taskId}] 结果\n${result.output}`);
    });

    const integrationInput = `请整合以下子任务结果：
${resultTexts.join("\n\n")}`;

    const integrator = this.agentMap.get("result-integrator");
    if (!integrator) {
      return resultTexts.join("\n\n");
    }

    const finalResult = await this.framework.run(integrationInput, {
      agent: "result-integrator",   // ← 用整合者 Agent
    });
    return finalResult.output;
  }

  /**
   * 完整工作流：拆解 → 并行执行 → 整合
   */
  async process(originalTask: string): Promise<string> {
    console.log("\n" + "=".repeat(60));
    console.log("🤖 Multi-Agent 任务处理系统启动");
    console.log("=".repeat(60));
    console.log(`\n📋 原始任务: ${originalTask}`);

    // 1. 任务拆解
    console.log("\n🔍 阶段 1: 任务拆解");
    const decomposition = await this.framework.run(originalTask, {
      agent: "task-decomposer",     // ← 用拆解大师 Agent
      context: { phase: "decomposition" },
    });
    console.log("拆解结果:", decomposition.output);

    const subtasks = this.parseDecomposition(decomposition.output);
    console.log(`\n📝 识别到 ${subtasks.length} 个子任务:`);
    subtasks.forEach((t) => {
      console.log(`  - [${t.taskId}] ${t.description} (${t.agentType}, P${t.priority})`);
    });

    // 2. 并行执行
    const results = await this.executeSubtasks(subtasks);

    // 3. 结果整合
    const finalOutput = await this.integrateResults(results);

    console.log("\n" + "=".repeat(60));
    console.log("✅ 全部完成！最终输出:");
    console.log("=".repeat(60));
    console.log(finalOutput);
    
    return finalOutput;
  }
}

// ============================================================
// 第四步：主程序
// ============================================================

async function main() {
  console.log("\n" + "╔════════════════════════════════════════════════════════╗");
  console.log("║     Multi-Agent 任务自动拆解与并行执行系统演示       ║");
  console.log("╚════════════════════════════════════════════════════════╝");

  // 1. 初始化 Framework
  const framework = new Framework();

  // 2. 注册模型
  framework.useModel(new EchoModelProvider("echo"));

  // 3. 注册所有 Agent
  const agents = [taskDecomposer, textAnalyst, codeEngineer, dataScientist, resultIntegrator];
  agents.forEach((agent) => framework.useAgent(agent));

  // 4. 注册全局工具
  framework.useTool(textAnalyzer);
  framework.useTool(codeProcessor);
  framework.useTool(dataCalculator);

  // 5. 启动框架
  await framework.start();

  // 6. 创建协调器
  const coordinator = new ParallelTaskCoordinator(framework, agents);

  // 7. 演示任务（多个示例）
  const demoTasks = [
    "分析这段文本: '人工智能正在改变世界，它让生活变得更美好，也带来了新的挑战。'",
    "帮我：1.分析'Hello World'代码 2.计算 1-100 的和 3.分析上面两段结果",
    "写一个简单的登录页面，同时分析其安全问题和性能优化空间",
  ];

  // 运行第一个演示任务
  const selectedTask = demoTasks[0];
  await coordinator.process(selectedTask);

  // 9. 停止框架
  await framework.stop();
  console.log("\n👋 系统已停止");
}

// ============================================================
// 辅助函数
// ============================================================

function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractKeywords(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 2);
  return words.slice(0, 5);
}

function analyzeSentiment(text: string): string {
  const positiveWords = ["好", "美好", "棒", "优秀", "成功", "进步", "改善"];
  const hasPositive = positiveWords.some((word) => text.includes(word));
  return hasPositive ? "正面" : "中性";
}

function generateSampleCode(lang: string, requirement: string): string {
  if (lang.toLowerCase() === "python") {
    return `def main():
    print("Hello from ${requirement}")
if __name__ == "__main__":
    main()`;
  }
  return `function main() {
  console.log("Hello from ${requirement}");
}
main();`;
}

// 运行主程序
main().catch(console.error);
