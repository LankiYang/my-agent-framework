/**
 * HTML 任务专门演示
 * 展示 Multi-Agent 系统如何处理"写 HTML 代码"的任务
 */

import {
  Framework,
  defineAgent,
  defineTool,
  EchoModelProvider,
} from "../src/index.js";
import type { AgentDef, ToolDef } from "../src/index.js";

// ============================================================
// 第一步：创建 HTML 专用工具
// ============================================================

/**
 * 工具1：HTML 生成器
 */
const htmlGenerator = defineTool({
  name: "html_generator",
  description: "生成各种类型的 HTML 代码",
  inputSchema: {
    type: "object",
    properties: {
      componentType: { type: "string", enum: ["page", "form", "table", "card", "navbar"] },
      title: { type: "string" },
      description: { type: "string" },
    },
    required: ["componentType"],
  },
  async execute(input) {
    const type = (input.componentType as string) || "page";
    const title = (input.title as string) || "示例页面";
    const description = (input.description as string) || "";
    
    await simulateDelay(500);

    let html = "";
    switch (type) {
      case "page":
        html = generateFullPage(title, description);
        break;
      case "form":
        html = generateForm(title);
        break;
      case "table":
        html = generateTable(title);
        break;
      case "card":
        html = generateCard(title, description);
        break;
      case "navbar":
        html = generateNavbar(title);
        break;
    }
    
    console.log(`[html_generator] 生成 ${type} 完成`);
    return { 
      content: html,
      artifacts: { type, title, lineCount: html.split("\n").length }
    };
  },
  isReadOnly: true,
});

/**
 * 工具2：CSS 美化器
 */
const cssStylist = defineTool({
  name: "css_stylist",
  description: "为 HTML 添加美观的 CSS 样式",
  inputSchema: {
    type: "object",
    properties: {
      style: { type: "string", enum: ["modern", "minimal", "colorful", "dark"] },
    },
    required: ["style"],
  },
  async execute(input) {
    const style = (input.style as string) || "modern";
    
    await simulateDelay(300);

    const css = generateCSS(style);
    console.log(`[css_stylist] 生成 ${style} 风格 CSS 完成`);
    
    return { 
      content: css,
      artifacts: { style, ruleCount: css.split("}").length }
    };
  },
  isReadOnly: true,
});

/**
 * 工具3：代码质量检查
 */
const codeChecker = defineTool({
  name: "code_checker",
  description: "检查 HTML/CSS 代码质量",
  inputSchema: {
    type: "object",
    properties: {
      codeType: { type: "string", enum: ["html", "css"] },
      code: { type: "string" },
    },
    required: ["codeType", "code"],
  },
  async execute(input) {
    const codeType = (input.codeType as string);
    const code = (input.code as string);
    
    await simulateDelay(250);

    const report = generateQualityReport(codeType, code);
    console.log(`[code_checker] ${codeType} 质量检查完成`);
    
    return { 
      content: report,
      artifacts: { codeType, issuesFound: report.includes("建议") ? 2 : 0 }
    };
  },
  isReadOnly: true,
});

// ============================================================
// 第二步：创建 HTML 专业 Agent
// ============================================================

/**
 * Agent：UI 设计师
 */
const uiDesigner = defineAgent({
  id: "ui-designer",
  name: "UI 设计师",
  model: "echo",
  systemPrompt: `你是专业的 UI 设计师。
你的职责：
1. 分析用户需求，确定页面类型和风格
2. 规划页面布局和组件结构
3. 提供美学建议

请使用 html_generator 和 css_stylist 工具。`,
  tools: [htmlGenerator, cssStylist],
  maxTurns: 5,
});

/**
 * Agent：前端工程师
 */
const frontendEngineer = defineAgent({
  id: "frontend-engineer",
  name: "前端工程师",
  model: "echo",
  systemPrompt: `你是专业的前端工程师。
你的职责：
1. 生成高质量的 HTML 结构
2. 编写语义化标签
3. 确保代码可维护性

请使用 html_generator 和 code_checker 工具。`,
  tools: [htmlGenerator, codeChecker],
  maxTurns: 5,
});

/**
 * Agent：质量保证
 */
const qaEngineer = defineAgent({
  id: "qa-engineer",
  name: "质量保证工程师",
  model: "echo",
  systemPrompt: `你是专业的 QA 工程师。
你的职责：
1. 检查代码质量
2. 验证可访问性
3. 提供改进建议

请使用 code_checker 工具。`,
  tools: [codeChecker],
  maxTurns: 3,
});

/**
 * Agent：任务拆解专家（HTML 优化版）
 */
const htmlTaskDecomposer = defineAgent({
  id: "html-decomposer",
  name: "HTML 任务拆解专家",
  model: "echo",
  systemPrompt: `你是专业的 HTML 任务拆解专家。
请将 HTML 相关任务拆分为：
1. UI 设计（分配给 ui-designer）
2. 代码实现（分配给 frontend-engineer）
3. 质量检查（分配给 qa-engineer）`,
  tools: [htmlGenerator],
  maxTurns: 3,
});

// ============================================================
// 第三步：HTML 任务协调器
// ============================================================

class HTMLTaskCoordinator {
  private framework: Framework;
  private agentMap: Map<string, AgentDef>;

  constructor(framework: Framework, agents: AgentDef[]) {
    this.framework = framework;
    this.agentMap = new Map(agents.map(a => [a.id, a]));
  }

  /**
   * 模拟智能拆解 HTML 任务
   */
  decomposeHTMLTask(task: string): any[] {
    console.log("\n🔍 HTML 任务智能分析中...");
    console.log(`📝 任务描述: ${task}`);

    // 这里模拟 LLM 的任务拆解结果
    const subtasks = [
      {
        taskId: "ui",
        description: `设计页面风格和布局 - 基于需求: ${task}`,
        agentType: "ui-designer",
        priority: 1
      },
      {
        taskId: "code",
        description: `实现 HTML 结构 - 基于需求: ${task}`,
        agentType: "frontend-engineer",
        priority: 2
      },
      {
        taskId: "qa",
        description: `检查代码质量 - 基于需求: ${task}`,
        agentType: "qa-engineer",
        priority: 3
      }
    ];

    console.log("\n📋 拆解为以下并行子任务:");
    subtasks.forEach(t => {
      console.log(`  ${t.priority}. [${t.taskId}] ${t.agentType}: ${t.description.substring(0, 40)}...`);
    });

    return subtasks;
  }

  /**
   * 执行 HTML 任务完整流程
   */
  async process(task: string) {
    console.log("\n" + "╔═══════════════════════════════════════════════════════════╗");
    console.log("║       HTML 任务 Multi-Agent 处理演示                       ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");

    // 1. 任务拆解
    const subtasks = this.decomposeHTMLTask(task);

    // 2. 并行执行所有子任务
    console.log("\n🚀 开始并行执行子任务...");
    
    const results: Record<string, any> = {};
    
    await Promise.all(subtasks.map(async (subtask) => {
      const agent = this.agentMap.get(subtask.agentType);
      if (!agent) return;

      console.log(`  → [${subtask.taskId}] 正在由 ${agent.name} 处理...`);
      
      const result = await this.framework.run(subtask.description, {
        context: { taskId: subtask.taskId }
      });
      
      results[subtask.taskId] = result;
      console.log(`  ✓ [${subtask.taskId}] ${agent.name} 完成!`);
    }));

    // 3. 生成最终报告
    console.log("\n" + "=".repeat(60));
    console.log("📊 最终执行报告");
    console.log("=".repeat(60));

    console.log("\n📁 [UI 设计] 输出:");
    console.log("  （页面风格、配色方案、布局结构）");

    console.log("\n💻 [代码实现] 输出:");
    console.log("  （HTML 结构、语义化标签、基础样式）");

    console.log("\n✅ [质量检查] 输出:");
    console.log("  （代码质量、可访问性、最佳实践检查）");

    // 4. 生成示例 HTML 代码
    console.log("\n" + "─".repeat(60));
    console.log("🎯 生成的最终 HTML 代码:");
    console.log("─".repeat(60));
    console.log(generateSampleHTML(task));

    console.log("\n✨ 任务处理完成！");
  }
}

// ============================================================
// 第四步：主程序
// ============================================================

async function main() {
  const framework = new Framework();

  // 注册模型
  framework.useModel(new EchoModelProvider("echo"));

  // 注册 Agent
  const agents = [htmlTaskDecomposer, uiDesigner, frontendEngineer, qaEngineer];
  agents.forEach(agent => framework.useAgent(agent));

  // 注册工具
  [htmlGenerator, cssStylist, codeChecker].forEach(tool => framework.useTool(tool));

  // 启动
  await framework.start();

  // 创建协调器
  const coordinator = new HTMLTaskCoordinator(framework, agents);

  // 演示任务
  const htmlTask = "写一个产品着陆页 HTML，包含导航栏、英雄区域、产品展示、联系表单";
  
  // 处理任务
  await coordinator.process(htmlTask);

  // 停止
  await framework.stop();
  console.log("\n👋 演示结束");
}

// ============================================================
// 辅助函数（模拟工具行为）
// ============================================================

function simulateDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateFullPage(title: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    /* 基础样式 */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', sans-serif; line-height: 1.6; color: #333; }
  </style>
</head>
<body>
  <header>
    <nav>
      <div class="logo">${title}</div>
      <ul class="nav-links">
        <li><a href="#home">首页</a></li>
        <li><a href="#products">产品</a></li>
        <li><a href="#about">关于</a></li>
        <li><a href="#contact">联系</a></li>
      </ul>
    </nav>
  </header>

  <section class="hero">
    <h1>${title}</h1>
    <p>${description || "欢迎来到我们的网站"}</p>
    <button>立即开始</button>
  </section>

  <footer>
    <p>&copy; 2024 ${title}. All rights reserved.</p>
  </footer>
</body>
</html>`;
}

function generateForm(title: string): string {
  return `<form class="contact-form">
  <h2>${title}</h2>
  <div class="form-group">
    <label>姓名</label>
    <input type="text" name="name" required>
  </div>
  <div class="form-group">
    <label>邮箱</label>
    <input type="email" name="email" required>
  </div>
  <div class="form-group">
    <label>留言</label>
    <textarea name="message" rows="4" required></textarea>
  </div>
  <button type="submit">发送</button>
</form>`;
}

function generateTable(title: string): string {
  return `<table class="data-table">
  <caption>${title}</caption>
  <thead>
    <tr>
      <th>ID</th>
      <th>名称</th>
      <th>价格</th>
      <th>状态</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>1</td>
      <td>商品A</td>
      <td>¥99</td>
      <td>有货</td>
    </tr>
    <tr>
      <td>2</td>
      <td>商品B</td>
      <td>¥199</td>
      <td>有货</td>
    </tr>
  </tbody>
</table>`;
}

function generateCard(title: string, description: string): string {
  return `<div class="card">
  <div class="card-content">
    <h3>${title}</h3>
    <p>${description}</p>
    <button class="card-btn">了解更多</button>
  </div>
</div>`;
}

function generateNavbar(title: string): string {
  return `<nav class="navbar">
  <div class="container">
    <div class="navbar-brand">${title}</div>
    <div class="navbar-menu">
      <a href="#" class="navbar-item">首页</a>
      <a href="#" class="navbar-item">产品</a>
      <a href="#" class="navbar-item">文档</a>
      <a href="#" class="navbar-item">关于</a>
    </div>
  </div>
</nav>`;
}

function generateCSS(style: string): string {
  return `/* ${style} 风格 */
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
.navbar { background: #2563eb; color: white; padding: 1rem; }
.hero { background: linear-gradient(135deg, #2563eb, #3b82f6); color: white; padding: 6rem 2rem; text-align: center; }
.card { background: white; border-radius: 12px; padding: 2rem; margin: 1rem; box-shadow: 0 10px 15px rgba(0,0,0,0.1); }
footer { background: #1e293b; color: white; padding: 2rem; text-align: center; }`;
}

function generateQualityReport(codeType: string, code: string): string {
  return `✅ ${codeType.toUpperCase()} 质量检查报告
┌─────────────────────────────────────────┐
│ 状态           │ 结果                  │
├─────────────────────────────────────────┤
│ 语法检查       │ ✅ 通过               │
│ 可访问性       │ ⚠️  建议添加更多 alt 属性│
│ 语义化标签     │ ✅ 良好               │
│ 代码格式       │ ✅ 良好               │
└─────────────────────────────────────────┘

建议:
1. 考虑添加更多语义化标签
2. 确保所有图片都有 alt 属性
3. 添加适当的 ARIA 标签`;
}

function generateSampleHTML(task: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>产品着陆页 - 由 Multi-Agent 生成</title>
  <style>
    /* 由 UI 设计 Agent 生成 */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
    /* 导航栏 */
    .navbar { background: #2563eb; color: white; padding: 1rem; }
    .navbar-container { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; }
    .nav-links { display: flex; gap: 2rem; list-style: none; }
    .nav-links a { color: white; text-decoration: none; }
    /* Hero 区域 */
    .hero { background: linear-gradient(135deg, #2563eb, #3b82f6); color: white; padding: 6rem 2rem; text-align: center; }
    .hero h1 { font-size: 3rem; margin-bottom: 1rem; }
    /* 产品展示 */
    .products { max-width: 1200px; margin: 4rem auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2rem; }
    .product-card { background: white; border-radius: 12px; padding: 2rem; box-shadow: 0 10px 15px rgba(0,0,0,0.1); }
    /* 联系表单 */
    .contact { background: #f1f5f9; padding: 4rem 2rem; }
    .contact-form { max-width: 600px; margin: 0 auto; background: white; padding: 2rem; border-radius: 12px; }
    /* Footer */
    footer { background: #1e293b; color: white; padding: 2rem; text-align: center; }
  </style>
</head>
<body>
  <!-- 由前端工程师 Agent 生成 -->
  <nav class="navbar">
    <div class="navbar-container">
      <div class="logo">🚀 MyProduct</div>
      <ul class="nav-links">
        <li><a href="#home">首页</a></li>
        <li><a href="#products">产品</a></li>
        <li><a href="#contact">联系我们</a></li>
      </ul>
    </div>
  </nav>

  <section class="hero" id="home">
    <h1>让您的业务更上一层楼</h1>
    <p style="font-size: 1.25rem; margin-bottom: 2rem;">使用我们的产品，提升工作效率，实现更多可能</p>
    <button style="background: white; color: #2563eb; border: none; padding: 1rem 2rem; border-radius: 8px; font-weight: bold; cursor: pointer;">立即开始</button>
  </section>

  <section class="products" id="products">
    <div class="product-card">
      <h3 style="margin-bottom: 1rem; color: #2563eb;">产品特性</h3>
      <p style="color: #475569;">高性能、安全、易用</p>
    </div>
    <div class="product-card">
      <h3 style="margin-bottom: 1rem; color: #2563eb;">客户支持</h3>
      <p style="color: #475569;">7x24 小时在线服务</p>
    </div>
    <div class="product-card">
      <h3 style="margin-bottom: 1rem; color: #2563eb;">快速部署</h3>
      <p style="color: #475569;">5分钟快速上手</p>
    </div>
  </section>

  <section class="contact" id="contact">
    <form class="contact-form">
      <h2 style="margin-bottom: 1.5rem; color: #1e293b;">联系我们</h2>
      <div style="margin-bottom: 1rem;">
        <label style="display: block; margin-bottom: 0.5rem; font-weight: bold;">姓名</label>
        <input type="text" style="width: 100%; padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 6px;">
      </div>
      <div style="margin-bottom: 1rem;">
        <label style="display: block; margin-bottom: 0.5rem; font-weight: bold;">邮箱</label>
        <input type="email" style="width: 100%; padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 6px;">
      </div>
      <div style="margin-bottom: 1rem;">
        <label style="display: block; margin-bottom: 0.5rem; font-weight: bold;">留言</label>
        <textarea rows="4" style="width: 100%; padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 6px;"></textarea>
      </div>
      <button type="submit" style="background: #2563eb; color: white; border: none; padding: 1rem 2rem; border-radius: 6px; font-weight: bold; cursor: pointer; width: 100%;">发送消息</button>
    </form>
  </section>

  <footer>
    <p>&copy; 2024 MyProduct. All rights reserved. | 由 Multi-Agent 系统生成</p>
  </footer>
</body>
</html>`;
}

main().catch(console.error);
