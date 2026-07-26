# Agent Framework

TypeScript 多 Agent 编排框架，参考 Claude Code 和 AgentScope 的设计哲学。

## 特性

- **多 Agent 编排** — 内置 Sequential / Parallel / Router / Supervisor 四种编排模式
- **AsyncGenerator 流式推理** — 实时事件流，不阻塞
- **洋葱中间件** — 5 个 Hook 点，支持前后拦截
- **权限引擎** — 链式评估，5 种权限模式
- **工具分组** — 动态激活/停用
- **MCP 协议** — 标准化 AI 工具互通
- **沙盒执行** — Local / Docker 两种工作空间
- **ContentBlock 组合消息** — Text / ToolCall / ToolResult / Thinking / Data
- **Token 计数** — 中英代码分类估算
- **双层 API** — 高层声明式 + 底层可控

## 快速开始

```bash
npm install
```

### 30 秒上手

```typescript
import { createModel, createTool, createAgent, createApp } from './src/index.js'

// 接入模型（读取环境变量 ANTHROPIC_API_KEY / 或 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL）
const claude = createModel('claude', { model: 'claude-sonnet-4-20250514' })

// 定义工具
const echo = createTool('echo', '回显输入', async ({ text }) => text)

// 定义 Agent —— model 为必填
const assistant = createAgent({
  name: '助手',
  model: claude,          // ← 必填：传 provider 实例（或已注册的模型 id 字符串）
  prompt: '你是一个 AI 助手',
  tools: [echo],
})

// 启动（createApp 会自动收集 agents 携带的 model provider）
const app = createApp({ agents: [assistant] })
await app.chat('你好')
```

> ⚠️ **必读**：`createAgent` 的 `model` 是必填项。省略会在运行时报 “Model Provider 未注册”。
> 传入 provider 实例（`createModel(...)` 的返回值）时，`createApp` 会自动注册它；
> 若传字符串 id，则需自行 `framework.useModel(provider)` 或在 `createApp({ model })` 注册。

### 多 Agent 编排

```typescript
import { createModel, createAgent, pipe, parallel } from './src/index.js'

const claude = createModel('claude', {})

const coder = createAgent({ name: 'Coder', model: claude, prompt: '编写代码' })
const reviewer = createAgent({ name: 'Reviewer', model: claude, prompt: '审查代码' })
const tester = createAgent({ name: 'Tester', model: claude, prompt: '编写测试' })

// 流水线：Coder → Reviewer → Tester
const pipeline = pipe(coder, reviewer, tester)
const result = await pipeline.run('实现一个排序算法')

// 并行：多角度分析
const security = createAgent({ name: 'Security', model: claude, prompt: '安全分析' })
const perf = createAgent({ name: 'Perf', model: claude, prompt: '性能分析' })
const analysis = parallel(security, perf)
const report = await analysis.run('分析这段代码')

// 嵌套编排：并行子流程作为一个单元接入主流水线
const nested = pipe(coder, parallel(security, perf).asAgent('并行审查'), reviewer)

// Agent 当工具：让一个 Agent 把另一个 Agent 当子例程调用
import { agentAsTool } from './src/index.js'
const writer = createAgent({
  name: 'Writer',
  model: claude,
  prompt: '写文章；需要资料时调用 ask_researcher 工具',
  tools: [agentAsTool(coder, { description: '把子任务委派给编码 Agent' })],
})
```

### 自定义工具

```typescript
import { createTool, toolbox } from './src/index.js'

// 单个工具
const bash = createTool({
  name: 'bash',
  description: '执行命令',
  schema: { command: { type: 'string', required: true } },
  execute: async ({ command }) => execSync(command).toString(),
  readOnly: false,
})

// 批量定义
const fileTools = toolbox('file', {
  read: {
    description: '读取文件',
    execute: async ({ path }) => fs.readFileSync(path, 'utf-8'),
  },
  write: {
    description: '写入文件',
    execute: async ({ path, content }) => { fs.writeFileSync(path, content); return 'ok' },
    readOnly: false,
  },
})
```

### 中间件

```typescript
import { createMiddleware } from './src/index.js'

const logger = createMiddleware('logger', async (ctx, next) => {
  console.log(`[${ctx.agentId}] 开始`)
  const start = Date.now()
  await next()
  console.log(`[${ctx.agentId}] 完成 (${Date.now() - start}ms)`)
})
```

### 沙盒工作空间

```typescript
import { createApp } from './src/index.js'

const app = createApp({
  agents: [coder],
  workspace: { type: 'docker', workDir: '/workspace', docker: { image: 'node:20' } },
})
```

## 底层 API

框架同时暴露底层接口，供高级用户自定义：

```typescript
import {
  agentLoop, ToolExecutor, ContextManager,
  MiddlewarePipeline, HookRegistry, HookPoint,
  PermissionEngine, PermissionMode,
  Toolkit, ToolGroup,
  TokenCounter, MCPManager,
  WorkspaceBase, createWorkspace,
  SequentialOrchestrator, ParallelOrchestrator,
} from './src/index.js'

// 直接操控推理循环
const stream = agentLoop(messages, { model, tools, systemPrompt, maxTurns: 10 })
for await (const event of stream) {
  if (event.type === 'content_delta') process.stdout.write(event.delta)
}

// 自定义权限规则
const engine = new PermissionEngine()
engine.addRule({
  name: 'no-delete',
  priority: 0,
  evaluate: (ctx) => ctx.toolName === 'delete' ? 'denied' : null,
})
```

## 架构

```
┌─────────────────────────────────────────────────────┐
│              Developer API (api.ts)                   │
│  createTool / createAgent / createApp / pipe / ...   │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│                  Framework (index.ts)                 │
│  useAgent / useTool / useModel / useChannel / run    │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│                    Runtime Engine                     │
│  AgentLoop │ ToolExecutor │ ContextManager           │
│  Middleware │ Permission │ ToolGroup │ TokenCounter  │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│                   Orchestrator                        │
│  Sequential │ Parallel │ Router │ Supervisor         │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│                    Providers                          │
│  Model │ Channel │ Storage │ Workspace │ MCP        │
└─────────────────────────────────────────────────────┘
```

## 目录结构

```
src/
├── index.ts                    # Framework 主入口
├── api.ts                      # 高层开发者 API
├── core/
│   ├── types.ts                # 核心类型定义
│   └── event-bus.ts            # 事件总线
├── runtime/
│   ├── agent-loop.ts           # 推理循环（State + Continue Sites）
│   ├── tool-executor.ts        # 工具并行编排
│   ├── context-manager.ts      # 上下文管理
│   ├── context-block.ts        # ContentBlock 消息系统
│   ├── middleware.ts           # 洋葱中间件
│   ├── permission.ts           # 权限引擎
│   ├── tool-group.ts           # 工具分组
│   └── token-counter.ts        # Token 计数
├── orchestrator/
│   └── index.ts                # 4 种编排模式
├── mcp/
│   ├── types.ts                # MCP 类型
│   ├── client.ts               # MCP 客户端
│   └── manager.ts              # MCP 管理器
├── provider/
│   ├── model/index.ts          # Model 抽象
│   ├── channel/index.ts        # Channel 抽象
│   ├── storage/index.ts        # 存储（Memory / File）
│   ├── workspace.ts            # 沙盒（Local / Docker）
│   └── mcp.ts                  # MCP Provider
└── utils/
    └── token-counter.ts        # Token 工具函数
examples/
├── basic-agent.ts              # 基础示例
└── validate-all.ts             # 全模块验证
```

## 设计参考

| 来源 | 借鉴的设计 |
|------|-----------|
| **Claude Code** | AsyncGenerator 推理循环、State + Continue Sites、Tool 契约、StreamEvent |
| **AgentScope** | ContentBlock 组合消息、洋葱中间件、权限引擎、工具分组 |
| **原创设计** | 多 Agent 编排器、双层 API、Channel 抽象、MCP 集成 |

## 运行示例

```bash
npx tsx examples/basic-agent.ts
```

## 运行验证

```bash
npx tsx examples/validate-all.ts
```

## License

MIT
