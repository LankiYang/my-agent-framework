# Agent Framework 开发者文档

> TypeScript 多 Agent 编排框架，参考 Claude Code 和 AgentScope 的设计哲学

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 快速开始](#2-快速开始)
- [3. 核心概念](#3-核心概念)
- [4. 类型系统](#4-类型系统)
- [5. 高层 API](#5-高层-api)
  - [5.1 createTool](#51-createtool)
  - [5.2 createAgent](#52-createagent)
  - [5.3 createApp](#53-createapp)
  - [5.4 createMiddleware](#54-createmiddleware)
  - [5.5 createChannel](#55-createchannel)
  - [5.6 createModel](#56-createmodel)
  - [5.7 pipe / parallel](#57-pipe--parallel)
  - [5.8 toolbox](#58-toolbox)
- [6. 底层 API](#6-底层-api)
  - [6.1 agentLoop — 推理循环](#61-agentloop--推理循环)
  - [6.2 ToolExecutor — 工具执行器](#62-toolexecutor--工具执行器)
  - [6.3 ContextManager — 上下文管理](#63-contextmanager--上下文管理)
  - [6.4 Toolkit — 工具管理器](#64-toolkit--工具管理器)
  - [6.5 Framework — 框架核心类](#65-framework--框架核心类)
- [7. 中间件与钩子系统](#7-中间件与钩子系统)
  - [7.1 洋葱模型](#71-洋葱模型)
  - [7.2 HookPoint 枚举](#72-hookpoint-枚举)
  - [7.3 HookRegistry](#73-hookregistry)
  - [7.4 管道变换钩子](#74-管道变换钩子)
- [8. 多 Agent 编排](#8-多-agent-编排)
  - [8.1 SequentialOrchestrator](#81-sequentialorchestrator)
  - [8.2 ParallelOrchestrator](#82-parallelorchestrator)
  - [8.3 RouterOrchestrator](#83-routerorchestrator)
  - [8.4 SupervisorOrchestrator](#84-supervisororchestrator)
- [9. 权限引擎](#9-权限引擎)
- [10. 沙盒工作空间](#10-沙盒工作空间)
- [11. MCP 协议集成](#11-mcp-协议集成)
- [12. Token 计数](#12-token-计数)
- [13. ContentBlock 消息系统](#13-contentblock-消息系统)
- [14. 存储提供者](#14-存储提供者)
- [15. 事件系统](#15-事件系统)
- [16. 架构总览](#16-架构总览)
- [17. API 速查表](#17-api-速查表)

---

## 1. 项目概述

Agent Framework 是一个基于 TypeScript 的多 Agent 开发框架，核心设计参考了 Claude Code 的推理循环架构和 AgentScope 的中间件/权限系统。框架提供**双层 API**：

- **高层声明式 API**：`createTool` / `createAgent` / `createApp` / `pipe` / `parallel`，最少配置即可运行
- **底层可控 API**：`agentLoop` / `ToolExecutor` / `HookRegistry` / `PermissionEngine`，完全掌控执行细节

### 核心特性

| 特性 | 说明 |
|------|------|
| AsyncGenerator 流式推理 | `agentLoop()` 产出事件流，调用方增量消费 |
| State Object + Continue Sites | 单个 LoopState 管理跨迭代可变状态 |
| 10 种终止原因 | completed / max_turns / aborted_streaming / aborted_tools / model_error / prompt_too_long / blocking_limit / hook_prevented / budget_exhausted / permission_denied |
| 5 种继续原因 | next_turn / max_output_recovery / prompt_too_long_recovery / hook_blocking_retry / token_budget_continuation |
| 恢复策略 | prompt_too_long 压缩重试、max_output_tokens 续写、hook blocking 注入错误重试 |
| 洋葱中间件 | 5 个 Hook 点，前后拦截 |
| 链式权限引擎 | 5 种权限模式，自定义规则 |
| 工具分组 | 动态激活/停用工具组 |
| MCP 协议 | JSON-RPC 2.0 over stdio，工具发现/调用 |
| 沙盒执行 | Local / Docker 两种工作空间 |
| 多 Agent 编排 | Sequential / Parallel / Router / Supervisor |

---

## 2. 快速开始

### 安装

```bash
cd my-agent-framework
npm install
```

### 30 秒上手

```typescript
import { createTool, createAgent, createApp } from './src/index.js'

// 1. 定义工具
const echo = createTool('echo', '回显输入', async ({ text }) => text)

// 2. 定义 Agent
const assistant = createAgent({
  name: '助手',
  prompt: '你是一个 AI 助手',
  tools: [echo],
})

// 3. 创建应用并运行
const app = createApp({ agents: [assistant] })
const result = await app.chat('你好')
```

### 编译与运行

```bash
# 编译 TypeScript
npm run build

# 运行示例
npx tsx examples/basic-agent.ts

# 全模块验证
npx tsx examples/validate-all.ts
```

---

## 3. 核心概念

### 3.1 Agent

Agent 是框架的核心执行单元，由系统提示词、工具列表和模型配置组成：

```typescript
interface AgentDef {
  id: AgentId              // 唯一标识
  name: string             // 显示名称
  model: string            // 模型标识
  systemPrompt: string     // 系统提示词
  tools: ToolDef[]         // 可用工具列表
  hooks?: Partial<Record<HookPoint, HookFn>>  // 生命周期钩子
  maxTurns?: number        // 最大对话轮次
}
```

### 3.2 Tool

Tool 是 Agent 与外部世界交互的接口：

```typescript
interface ToolDef {
  name: string             // 唯一名称
  description: string      // 描述
  inputSchema: Record<string, unknown>  // JSON Schema 输入定义
  execute(input: ToolInput, context: SharedContext): Promise<ToolOutput>
  isEnabled?(context: SharedContext): boolean     // 动态可用性
  isConcurrencySafe?: boolean                     // 是否并发安全
  isReadOnly?: boolean                            // 是否只读
  validateInput?(input: ToolInput): { valid: boolean; error?: string }
  checkPermissions?(context: SharedContext): Promise<boolean>
}
```

### 3.3 推理循环

Agent 的推理过程由 `agentLoop()` 驱动，采用 **State Object + Continue Sites** 模式：

```
while (true) {
  1. 检查中断信号
  2. 轮次计数 + 最大轮次检查
  3. 消息预处理管道（token 裁剪 → blocking limit → 预算检查）
  4. 调用模型（流式）
  5. 处理模型响应
  6. 无工具调用 → 检查恢复策略或正常完成
  7. 有工具调用 → 执行工具 → Continue Site: next_turn
}
```

### 3.4 共享上下文

`SharedContext` 在多 Agent 间传递状态：

```typescript
interface SharedContext {
  messages: Message[]                    // 对话消息历史
  artifacts: Record<string, unknown>     // 产出物
  metadata: Record<string, unknown>      // 元数据
  parentAgentId?: AgentId                // 父级 Agent（层级结构）
}
```

---

## 4. 类型系统

### 消息类型

```typescript
type MessageRole = "user" | "assistant" | "system" | "tool"
type MessageType = "text" | "tool_call" | "tool_result"

interface Message {
  id: string
  role: MessageRole
  type: MessageType
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}
```

### 工具类型

```typescript
type ToolInput = Record<string, unknown>

type ToolOutput = {
  content: string
  artifacts?: Record<string, unknown>[]
}
```

### 流式事件

```typescript
type StreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "tool_use"; toolName: string; toolInput: ToolInput; toolCallId: string }
  | { type: "end_turn"; stopReason: string }
  | { type: "error"; error: Error }
```

### 模型接口

```typescript
interface ModelProvider {
  id: string
  generate(
    messages: Message[],
    tools: ToolDef[],
    systemPrompt: string
  ): AsyncGenerator<StreamEvent, void, unknown>
}
```

### 编排策略

```typescript
enum OrchestratorStrategy {
  Sequential = "sequential",
  Parallel = "parallel",
  Router = "router",
  Supervisor = "supervisor",
  Hierarchy = "hierarchy",
}
```

---

## 5. 高层 API

### 5.1 createTool

创建工具定义，支持两种调用形式。

#### 对象配置形式

```typescript
import { createTool } from './src/index.js'

const bash = createTool({
  name: 'bash',
  description: '执行 shell 命令',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' }
    },
    required: ['command']
  },
  execute: async ({ command }) => {
    const { execSync } = await import('node:child_process')
    return execSync(command as string).toString()
  },
  readOnly: false,
  concurrencySafe: false,
})
```

#### 三参数简写形式

```typescript
const echo = createTool('echo', '回显输入文本', async ({ text }) => text as string)
```

**参数说明：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `nameOrConfig` | `string \| ToolConfig` | 工具名称或完整配置对象 |
| `description` | `string` | 工具描述（三参数形式） |
| `handler` | `(input, context) => Promise<string \| ToolOutput>` | 执行函数（三参数形式） |

**ToolConfig 接口：**

```typescript
interface ToolConfig<TInput extends ToolInput = ToolInput> {
  name: string
  description: string
  schema?: Record<string, unknown>       // JSON Schema
  execute: (input: TInput, context: SharedContext) => Promise<string | ToolOutput>
  readOnly?: boolean                     // 默认 true
  concurrencySafe?: boolean              // 默认 true
}
```

> **注意**：`execute` 返回 `string` 时会自动包装为 `{ content: string }`。

---

### 5.2 createAgent

声明式创建 Agent 定义。

```typescript
import { createAgent, createTool } from './src/index.js'

const readFile = createTool('readFile', '读取文件', async ({ path }) => {
  const fs = await import('node:fs/promises')
  return fs.readFile(path as string, 'utf-8')
})

const coder = createAgent({
  name: 'Coder',
  description: '编程助手',
  model: 'claude-sonnet-4-20250514',    // 模型标识字符串
  prompt: '你是一个专业的编程助手，擅长编写高质量代码。',
  tools: [readFile],
  maxTurns: 50,
  permissionMode: 'default',             // 权限模式
})
```

**AgentConfig 接口：**

```typescript
interface AgentConfig {
  name: string
  description?: string
  model: string | ModelProvider          // 字符串或 ModelProvider 实例
  prompt?: string                        // 系统提示词
  tools?: ToolDef[]                      // 工具列表
  maxTurns?: number                      // 最大轮次
  middleware?: Array<{ name: string; fn: MiddlewareFn }>
  permissionMode?: keyof typeof PermissionMode | PermissionMode
}
```

> `createAgent` 会自动生成 `id`，格式为 `agent-{name}-{timestamp36}`。

---

### 5.3 createApp

创建应用实例 — 最高层抽象，封装了 Framework 的注册和启动逻辑。

```typescript
import { createApp, createAgent, createTool } from './src/index.js'

const search = createTool('search', '搜索', async ({ query }) => `搜索结果: ${query}`)
const coder = createAgent({ name: 'Coder', prompt: '编程助手', model: 'claude-3.5-sonnet', tools: [search] })
const reviewer = createAgent({ name: 'Reviewer', prompt: '代码审查', model: 'claude-3.5-sonnet' })

const app = createApp({
  agents: [coder, reviewer],
  tools: [search],                       // 全局工具，自动附加到所有 Agent
  workspace: { type: 'local', workDir: '/tmp/workspace' },
})

// 单次对话
const result = await app.chat('写一个 hello world')

// 多 Agent 编排
const orchestrateResult = await app.orchestrate({
  strategy: 'sequential',
  agents: ['Coder', 'Reviewer'],         // 按 name 或 id 查找
  input: '实现一个排序算法',
})
```

**AppConfig 接口：**

```typescript
interface AppConfig {
  agents?: AgentDef[]
  tools?: ToolDef[]                       // 全局共享工具
  model?: ModelProvider                   // 默认模型
  workspace?: WorkspaceConfig             // 工作空间
  storage?: "memory" | "file" | StorageProvider
}
```

**App 接口：**

```typescript
interface App {
  framework: Framework                    // 内部 Framework 实例
  chat(input: string): Promise<AgentResult>
  listen(config: ListenConfig): Promise<void>
  orchestrate(config: OrchestrateConfig): Promise<OrchestratorResult>
}
```

---

### 5.4 createMiddleware

创建洋葱模型中间件。

```typescript
import { createMiddleware } from './src/index.js'

const logger = createMiddleware('logger', async (ctx, next) => {
  console.log(`[${ctx.agentId}] 开始处理`)
  const start = Date.now()
  await next()
  console.log(`[${ctx.agentId}] 完成 (${Date.now() - start}ms)`)
})

const validator = createMiddleware('validator', async (ctx, next) => {
  if (ctx.messages.length === 0) {
    throw new Error('消息列表不能为空')
  }
  await next()
})
```

**SimpleMiddlewareContext 接口：**

```typescript
interface SimpleMiddlewareContext {
  agentId: string
  messages: Message[]
  systemPrompt: string
  [key: string]: unknown      // 允许扩展
}
```

中间件支持**洋葱模型**：`next()` 之前的代码在入站阶段执行，之后的代码在出站阶段执行。

```typescript
const timing = createMiddleware('timing', async (ctx, next) => {
  // 入站：请求到达时
  ctx.startTime = Date.now()
  await next()
  // 出站：响应返回时
  const duration = Date.now() - (ctx.startTime as number)
  console.log(`耗时: ${duration}ms`)
})
```

---

### 5.5 createChannel

创建消息渠道，支持 CLI / HTTP / Custom 三种类型。

#### CLI 渠道

```typescript
import { createChannel } from './src/index.js'

const cli = createChannel('cli', { prompt: '> ' })
```

#### HTTP 渠道

```typescript
const http = createChannel('http', { port: 3000, host: '0.0.0.0' })
```

#### 自定义渠道

```typescript
const custom = createChannel('custom', {
  name: 'wecom',
  start: async (onMessage) => {
    // 启动消息监听，收到消息时调用 onMessage
    ws.on('message', (data) => onMessage(parseMessage(data)))
  },
  sendMessage: async (message) => {
    // 发送消息到外部系统
    ws.send(JSON.stringify(message))
  },
  stop: async () => {
    ws.close()
  },
})
```

---

### 5.6 createModel

创建模型提供者，支持 Claude / OpenAI / Custom 三种类型。

#### Claude 模型

```typescript
import { createModel } from './src/index.js'

const claude = createModel('claude', {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
  baseURL: 'https://api.anthropic.com',
})
```

#### OpenAI 模型

```typescript
const gpt = createModel('openai', {
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  baseURL: 'https://api.openai.com/v1',
})
```

#### 自定义模型

```typescript
const custom = createModel('custom', {
  id: 'my-model',
  generate: async function* (messages, tools, systemPrompt) {
    // 自定义流式生成逻辑
    yield { type: 'content_delta', delta: 'Hello' }
    yield { type: 'content_delta', delta: ' World' }
    yield { type: 'end_turn', stopReason: 'end_turn' }
  },
})
```

> **注意**：Claude 和 OpenAI 的 `generate` 方法目前为占位实现，实际使用时需接入对应 SDK。

---

### 5.7 pipe / parallel

编排便捷语法，无需手动创建编排器。

#### pipe — 顺序流水线

```typescript
import { createAgent, pipe } from './src/index.js'

const coder = createAgent({ name: 'Coder', prompt: '编写代码', model: 'claude-3.5-sonnet' })
const reviewer = createAgent({ name: 'Reviewer', prompt: '审查代码', model: 'claude-3.5-sonnet' })
const tester = createAgent({ name: 'Tester', prompt: '编写测试', model: 'claude-3.5-sonnet' })

// Coder → Reviewer → Tester，前一个的输出作为下一个的输入
const pipeline = pipe(coder, reviewer, tester)
const result = await pipeline.run('实现一个排序算法')
```

#### parallel — 并行执行

```typescript
import { parallel } from './src/index.js'

const security = createAgent({ name: 'Security', prompt: '安全分析', model: 'claude-3.5-sonnet' })
const perf = createAgent({ name: 'Perf', prompt: '性能分析', model: 'claude-3.5-sonnet' })
const style = createAgent({ name: 'Style', prompt: '代码风格', model: 'claude-3.5-sonnet' })

// 三个 Agent 同时接收相同输入，汇总结果
const analysis = parallel(security, perf, style)
const report = await analysis.run('分析这段代码')
```

**Pipeline 接口：**

```typescript
interface Pipeline {
  agents: AgentDef[]
  strategy: "sequential" | "parallel"
  run(input: string, context?: Record<string, unknown>): Promise<OrchestratorResult>
}
```

---

### 5.8 toolbox

批量定义一组相关工具，自动添加命名空间前缀。

```typescript
import { toolbox } from './src/index.js'

const fileTools = toolbox('file', {
  read: {
    description: '读取文件内容',
    execute: async ({ path }) => {
      const fs = await import('node:fs/promises')
      return fs.readFile(path as string, 'utf-8')
    },
  },
  write: {
    description: '写入文件',
    execute: async ({ path, content }) => {
      const fs = await import('node:fs/promises')
      await fs.writeFile(path as string, content as string)
      return 'ok'
    },
    readOnly: false,
    concurrencySafe: false,
  },
  list: {
    description: '列出目录',
    execute: async ({ path }) => {
      const fs = await import('node:fs/promises')
      const files = await fs.readdir(path as string)
      return files.join('\n')
    },
  },
})

// fileTools.read.name === "file.read"
// fileTools.write.name === "file.write"
// fileTools.list.name === "file.list"

// 直接用于 createAgent
const agent = createAgent({
  name: 'FileManager',
  tools: [fileTools.read, fileTools.write, fileTools.list],
})
```

**ToolboxItemConfig 接口：**

```typescript
interface ToolboxItemConfig {
  description: string
  execute: (input, context) => Promise<string | ToolOutput>
  readOnly?: boolean
  concurrencySafe?: boolean
  schema?: Record<string, unknown>
}
```

---

## 6. 底层 API

### 6.1 agentLoop — 推理循环

核心 AsyncGenerator，基于 Claude Code query.ts 的 **State Object + Continue Sites** 模式。

```typescript
import { agentLoop, EchoModelProvider } from './src/index.js'
import type { AgentLoopEvent, AgentLoopTerminal, StopReason, ContinueReason } from './src/index.js'

const model = new EchoModelProvider()
const messages = [
  { id: '1', role: 'user' as const, type: 'text' as const, content: 'Hello', timestamp: Date.now() }
]

const stream = agentLoop(messages, {
  model,
  tools: [],
  systemPrompt: '你是一个助手',
  maxTurns: 10,
  tokenBudget: 100000,
  abortSignal: undefined,
  maxOutputRecoveryLimit: 3,
})

// 消费事件流
for await (const event of stream) {
  switch (event.type) {
    case 'turn_start':
      console.log(`轮次 ${event.turn} 开始`)
      break
    case 'content_delta':
      process.stdout.write(event.delta)
      break
    case 'tool_exec_start':
      console.log(`工具 ${event.toolName} 开始执行`)
      break
    case 'tool_exec_end':
      console.log(`工具 ${event.toolName} 完成 (错误: ${event.isError})`)
      break
    case 'recovery':
      console.log(`恢复: ${event.reason} (尝试 ${event.attempt})`)
      break
    case 'compact':
      console.log(`上下文压缩: ${event.tokensBefore} → ${event.tokensAfter}`)
      break
    case 'turn_end':
      console.log(`轮次 ${event.turn} 结束: ${event.reason}`)
      break
  }
}

// 获取最终结果（generator 的 return value）
const terminal: AgentLoopTerminal = stream.return_value
// 注意：for-await-of 循环中无法直接获取 return value
// 需要手动迭代：
```

#### 手动迭代获取终止信息

```typescript
const stream = agentLoop(messages, options)

let terminal: AgentLoopTerminal
while (true) {
  const { value, done } = await stream.next()
  if (done) {
    terminal = value
    break
  }
  // 处理事件
  handleEvent(value)
}

console.log('终止原因:', terminal.reason)     // StopReason
console.log('总轮次:', terminal.turnCount)
console.log('最终消息:', terminal.messages)
```

#### AgentLoopOptions

```typescript
interface AgentLoopOptions {
  model: ModelProvider                     // 模型提供者
  tools: ToolDef[]                         // 可用工具列表
  systemPrompt: string                     // 系统提示词
  maxTurns?: number                        // 最大轮次（默认 50）
  abortSignal?: AbortSignal                // 中断信号
  tokenBudget?: number                     // Token 预算（字符估算）
  maxOutputRecoveryLimit?: number          // max_output 恢复上限（默认 3）
  deps?: Partial<AgentLoopDeps>            // 依赖注入
  hooks?: HookRegistry                     // Hook 注册中心
}
```

#### 依赖注入 (AgentLoopDeps)

```typescript
interface AgentLoopDeps {
  callModel: (messages, tools, systemPrompt) => AsyncGenerator<StreamEvent>
  executeTools: (calls, context, signal?) => Promise<Message[]>
  trimContext: (messages, budget) => Message[]
  applyHooks: (point, context) => Promise<MiddlewareContext>
}
```

未注入的依赖使用框架内置默认实现（`ToolExecutor` / `ContextManager` / `HookRegistry`）。

#### 终止原因 (StopReason)

| 原因 | 说明 |
|------|------|
| `completed` | 正常完成（模型无 tool_use） |
| `max_turns` | 达到最大轮次 |
| `aborted_streaming` | 流式阶段被中断 |
| `aborted_tools` | 工具执行阶段被中断 |
| `model_error` | 模型调用异常 |
| `prompt_too_long` | 提示过长且无法恢复 |
| `blocking_limit` | 超出硬性上下文限制（1M 字符） |
| `hook_prevented` | Hook 阻止继续 |
| `budget_exhausted` | Token 预算耗尽 |
| `permission_denied` | 所有工具权限被拒绝 |

#### 继续原因 (ContinueReason)

| 原因 | 说明 |
|------|------|
| `next_turn` | 工具执行完成，继续下一轮 |
| `max_output_recovery` | 输出超限恢复（追加续写提示） |
| `prompt_too_long_recovery` | 提示过长恢复（压缩后重试） |
| `hook_blocking_retry` | Hook blocking 后重试 |
| `token_budget_continuation` | Token 预算未耗尽 |

#### 恢复策略

1. **prompt_too_long**：压缩消息后重试（仅一次），压缩后仍过长则终止
2. **max_output_tokens**：追加"请继续"消息后重试（最多 N 次，默认 3 次）
3. **hook_blocking**：注入 Hook 拒绝消息后重试

---

### 6.2 ToolExecutor — 工具执行器

负责工具的验证、权限检查、执行和并发控制。

```typescript
import { ToolExecutor } from './src/index.js'
import type { ToolCallMessage, SharedContext } from './src/index.js'

const executor = new ToolExecutor([tool1, tool2, tool3])

// 批量执行（自动判断并发/串行）
const results = await executor.executeMany(calls, sharedContext, abortSignal)

// 单个执行
const result = await executor.executeSingle(call, sharedContext)
```

**执行策略：**
- `isConcurrencySafe: true` 的工具并行执行
- `isConcurrencySafe: false` 的工具串行执行

**单个工具执行流程：**

```
查找工具定义 → validateInput → checkPermissions → executeWithTimeout → 返回结果
```

**错误类型：**

```typescript
class ToolExecutionError extends Error {
  toolName: string
  callId: string
}

class ToolTimeoutError extends Error {
  toolName: string
  timeoutMs: number
}
```

默认超时时间：30 秒。

---

### 6.3 ContextManager — 上下文管理

负责消息构建、系统上下文附加、token 预算裁剪。

```typescript
import { ContextManager } from './src/index.js'

const cm = new ContextManager()

// 根据 Session 构建消息列表
const messages = cm.buildMessages({
  id: 'session-1',
  messages: [...],
  systemPrompt: '你是一个助手',
  metadata: {},
})

// Token 预算裁剪
const trimmed = cm.trimToTokenBudget(messages, 50000)

// 生成工具描述文本
const toolDesc = cm.getToolDescriptions([tool1, tool2])
```

**裁剪策略：**
1. 保留第一条 system 消息
2. 保留最近的对话消息
3. 从最早的对话消息开始删除，直到满足预算

**Token 估算：** 字符数 / 4（`CHARS_PER_TOKEN = 4`）

---

### 6.4 Toolkit — 工具管理器

统一管理工具注册、分组和调用。

```typescript
import { Toolkit } from './src/index.js'

const toolkit = new Toolkit()

// 注册工具
toolkit.registerTool(readTool)
toolkit.registerTools([writeTool, deleteTool, searchTool])

// 创建分组
toolkit.createGroup('fileOps', ['file.read', 'file.write', 'file.delete'], '文件操作')
toolkit.createGroup('search', ['search.web', 'search.local'], '搜索')

// 控制分组
toolkit.activateGroup('fileOps')
toolkit.deactivateGroup('search')

// 获取当前可用工具（激活分组 + 独立工具）
const available = toolkit.getAllTools()

// 按类别过滤
import { getToolsByCategory } from './src/index.js'
const fileTools = toolkit.filterTools(getToolsByCategory('file'))

// 直接调用工具
const result = await toolkit.callTool('file.read', { path: '/tmp/test.txt' }, sharedContext)
```

**分组可用性规则：**
- 属于至少一个激活分组的工具 → 可用
- 不属于任何分组的独立工具 → 始终可用
- 仅属于未激活分组的工具 → 不可用

---

### 6.5 Framework — 框架核心类

管理组件注册、生命周期和推理执行。

```typescript
import { Framework } from './src/index.js'

const fw = new Framework()

// 链式注册组件
fw.useModel(claudeProvider)
  .useTool(readTool)
  .useTool(writeTool)
  .useAgent(coderAgent)
  .useAgent(reviewerAgent)
  .useChannel(httpChannel)
  .useStorage(new MemoryStorage(), 'memory')
  .useWorkspace('default', { type: 'local', workDir: '/tmp' })
  .useMCP([{ name: 'tools', command: 'npx', args: ['mcp-server'] }])

// 事件监听
fw.on('agent:start', (event) => console.log('Agent 启动:', event.data))
fw.on('agent:end', (event) => console.log('Agent 完成:', event.data))

// 生命周期
await fw.start()           // 启动 Channel、连接 MCP、初始化 Workspace
const result = await fw.run('你好', { orchestrator: 'my-orch' })
await fw.stop()            // 停止 Channel、断开 MCP、关闭 Workspace
```

**注册方法：**

| 方法 | 参数 | 说明 |
|------|------|------|
| `useAgent(def)` | `AgentDef` | 注册 Agent |
| `useTool(def)` | `ToolDef` | 注册 Tool |
| `useModel(provider)` | `ModelProvider` | 注册 Model Provider |
| `useChannel(def)` | `ChannelDef` | 注册 Channel |
| `useStorage(provider, name)` | `StorageProvider, string` | 注册 Storage |
| `useOrchestrator(def, supervisor?)` | `OrchestratorDef, AgentDef?` | 注册编排器 |
| `useWorkspace(name, config)` | `string, WorkspaceConfig` | 注册工作空间 |
| `useMCP(configs)` | `MCPServerConfig[]` | 注册 MCP 服务器 |

**查询方法：**

| 方法 | 返回 |
|------|------|
| `getAgent(id)` | `AgentDef \| undefined` |
| `getTool(name)` | `ToolDef \| undefined` |
| `getModel(id)` | `ModelProvider \| undefined` |
| `getStorage(name)` | `StorageProvider \| undefined` |
| `getOrchestrator(id)` | `BaseOrchestrator \| undefined` |
| `getWorkspace(name)` | `WorkspaceBase \| undefined` |
| `getMCPManager()` | `MCPManager \| null` |

---

## 7. 中间件与钩子系统

### 7.1 洋葱模型

中间件按洋葱结构执行：外层中间件先入站，后出站；内层中间件后入站，先出站。

```
中间件A(入站) → 中间件B(入站) → 核心逻辑 → 中间件B(出站) → 中间件A(出站)
```

```typescript
import { MiddlewarePipeline } from './src/index.js'
import type { MiddlewareContext, MiddlewareFn } from './src/index.js'

const pipeline = new MiddlewarePipeline()

pipeline.use(async (ctx, next) => {
  console.log('A 入站')
  await next()
  console.log('A 出站')
})

pipeline.use(async (ctx, next) => {
  console.log('B 入站')
  await next()
  console.log('B 出站')
})

const context: MiddlewareContext = {
  messages: [],
  systemPrompt: '',
  tools: [],
  agentId: 'test',
}

const result = await pipeline.run(context)
// 输出：A 入站 → B 入站 → B 出站 → A 出站
```

### 7.2 HookPoint 枚举

```typescript
enum HookPoint {
  onReply = "on_reply",           // 拦截整个回复过程
  onReasoning = "on_reasoning",   // 拦截推理/模型调用阶段
  onActing = "on_acting",         // 拦截单次工具执行
  onModelCall = "on_model_call",  // 拦截原始模型 API 调用
  onSystemPrompt = "on_system_prompt",  // 管道模式转换系统提示词
}
```

### 7.3 HookRegistry

管理洋葱模型中间件钩子和管道变换钩子。

```typescript
import { HookRegistry, HookPoint } from './src/index.js'
import type { MiddlewareContext } from './src/index.js'

const registry = new HookRegistry()

// 注册洋葱模型钩子
registry.register(HookPoint.onReply, async (ctx, next) => {
  console.log('回复前:', ctx.messages.length)
  await next()
  console.log('回复后')
})

registry.register(HookPoint.onActing, async (ctx, next) => {
  console.log('工具执行前')
  await next()
  console.log('工具执行后')
})

// 应用钩子
await registry.apply(HookPoint.onReply, context)
```

### 7.4 管道变换钩子

管道模式（非洋葱），按注册顺序依次变换值，前一个的输出作为后一个的输入。

```typescript
// 注册变换钩子
registry.registerTransform<string>(HookPoint.onSystemPrompt, (prompt, ctx) => {
  return prompt + '\n\n当前时间: ' + new Date().toISOString()
})

registry.registerTransform<string>(HookPoint.onSystemPrompt, (prompt, ctx) => {
  return prompt + '\n\n可用工具: ' + ctx.tools.map(t => t.name).join(', ')
})

// 应用变换
const finalPrompt = await registry.applyTransform(HookPoint.onSystemPrompt, '你是一个助手', context)
```

---

## 8. 多 Agent 编排

### 8.1 SequentialOrchestrator

顺序流水线，前一个 Agent 的输出作为下一个的输入。

```typescript
import { SequentialOrchestrator } from './src/index.js'

const orchestrator = new SequentialOrchestrator({
  id: 'dev-pipeline',
  agents: [coder, reviewer, tester],
  strategy: 'sequential' as any,
})

const result = await orchestrator.run({
  input: '实现一个排序算法',
  context: { language: 'typescript' },
})

// result.output — 最后一个 Agent 的输出
// result.agentResults — 所有 Agent 的结果列表
// result.metadata — { strategy: "sequential", agentCount: 3 }
```

### 8.2 ParallelOrchestrator

并行执行，所有 Agent 接收相同输入，汇总结果。

```typescript
import { ParallelOrchestrator } from './src/index.js'

const orchestrator = new ParallelOrchestrator({
  id: 'code-review',
  agents: [securityAgent, perfAgent, styleAgent],
  strategy: 'parallel' as any,
})

const result = await orchestrator.run({ input: '分析这段代码' })

// result.output — 合并输出，格式：
// [Security]: ...
// [Perf]: ...
// [Style]: ...
```

### 8.3 RouterOrchestrator

根据路由函数决定分发给哪个 Agent。

```typescript
import { RouterOrchestrator } from './src/index.js'

const orchestrator = new RouterOrchestrator({
  id: 'smart-router',
  agents: [codeAgent, mathAgent, chatAgent],
  strategy: 'router' as any,
  route: (message, agents) => {
    const content = message.content.toLowerCase()
    if (content.includes('代码') || content.includes('编程')) {
      return agents.find(a => a.name === 'CodeAgent')!.id
    }
    if (content.includes('数学') || content.includes('计算')) {
      return agents.find(a => a.name === 'MathAgent')!.id
    }
    return agents.find(a => a.name === 'ChatAgent')!.id
  },
})

const result = await orchestrator.run({ input: '帮我写一段排序代码' })
```

**route 函数签名：**

```typescript
route?(message: Message, agents: AgentDef[]): AgentId | AgentId[]
```

返回单个 AgentId 或 AgentId 数组，支持返回 `AgentId`（string）或 `AgentDef`（object）。

### 8.4 SupervisorOrchestrator

监督者模式，supervisor Agent 负责分配任务给 worker Agent。

```typescript
import { SupervisorOrchestrator } from './src/index.js'

const supervisor = createAgent({
  name: 'Supervisor',
  prompt: '你是一个任务分配者，根据输入分配给合适的 worker。',
  model: 'claude-3.5-sonnet',
})

const orchestrator = new SupervisorOrchestrator(
  {
    id: 'team',
    agents: [frontendAgent, backendAgent, dbAgent],
    strategy: 'supervisor' as any,
  },
  supervisor,  // supervisor Agent 作为第二个参数
)

const result = await orchestrator.run({ input: '开发一个用户管理系统' })
```

**执行流程：**
1. Supervisor 分析输入，输出 JSON 格式的任务分配计划
2. 解析分配计划：`[{ agentId, task }]`
3. 按计划分发给对应 worker 执行
4. 汇总所有 worker 的结果

### 工厂函数

```typescript
import { createOrchestrator } from './src/index.js'

const orchestrator = createOrchestrator({
  def: {
    id: 'my-orch',
    agents: [agent1, agent2],
    strategy: 'sequential' as any,
  },
  supervisor: undefined,  // supervisor 模式时必须提供
})
```

---

## 9. 权限引擎

链式权限评估，支持 5 种权限模式和自定义规则。

### 权限模式

```typescript
enum PermissionMode {
  Default = "default",         // 默认：破坏性工具需要 Ask
  AcceptEdits = "accept_edits", // 接受编辑：自动允许编辑操作
  Explore = "explore",         // 探索：只读，拒绝写操作
  Bypass = "bypass",           // 绕过：允许所有操作
  DontAsk = "dont_ask",        // 不询问：Ask 转为 Denied
}
```

### 权限等级

```typescript
enum PermissionLevel {
  Allowed = "allowed",
  Denied = "denied",
  Ask = "ask",
  Bypass = "bypass",
}
```

### 使用方式

```typescript
import { PermissionEngine, PermissionMode, PermissionLevel } from './src/index.js'

const engine = new PermissionEngine()

// 快捷检查
const level = engine.checkToolPermission(
  'file.delete',           // 工具名
  { path: '/etc/passwd' }, // 输入
  [deleteTool],            // 工具列表
  PermissionMode.Explore,  // 权限模式
)
// level === PermissionLevel.Denied (Explore 模式下写操作被拒绝)

// 自定义规则
engine.addRule({
  name: 'no-rm-rf',
  priority: -1,  // 最高优先级
  description: '禁止 rm -rf 命令',
  evaluate: (ctx) => {
    const command = ctx.input.command as string
    if (command?.includes('rm -rf')) {
      return PermissionLevel.Denied
    }
    return null  // null 表示跳过，交给下一条规则
  },
})

// 移除规则
engine.removeRule('no-rm-rf')

// 查看当前规则
const rules = engine.getRules()
```

### 内置规则链

按优先级排列：

| 优先级 | 名称 | 说明 |
|--------|------|------|
| 0 | `builtin:deny` | Explore 模式下拒绝写操作 |
| 1 | `builtin:allow` | Bypass 模式允许所有 |
| 2 | `builtin:ask` | 非 Bypass 模式下破坏性工具需要 Ask |

### 评估流程

1. 按优先级依次执行规则
2. 遇到非 null 结果则返回
3. DontAsk 模式下，Ask 结果转为 Denied
4. 所有规则均跳过时，返回模式默认值

---

## 10. 沙盒工作空间

提供统一的沙盒环境接口，支持 Local 和 Docker 两种实现。

### WorkspaceBase 抽象类

```typescript
abstract class WorkspaceBase {
  config: WorkspaceConfig
  status: WorkspaceStatus  // "created" | "running" | "stopped" | "error"

  abstract initialize(): Promise<void>
  abstract close(): Promise<void>
  abstract execCommand(command: string, timeout?: number): Promise<CommandResult>
  abstract readFile(path: string): Promise<FileResult>
  abstract writeFile(path: string, content: string): Promise<FileResult>
  abstract deleteFile(path: string): Promise<FileResult>
  abstract listFiles(dir: string): Promise<FileResult>
  abstract exists(path: string): Promise<FileResult>

  isRunning(): boolean
  checkFileAccess(filePath: string, operation: FileOperation): void
}
```

### LocalWorkspace

直接在宿主机上执行命令和文件操作。

```typescript
import { createWorkspace } from './src/index.js'

const ws = createWorkspace({
  type: 'local',
  workDir: '/tmp/my-workspace',
  filesystem: {
    allowedReadDirs: ['/tmp/my-workspace', '/data'],
    allowedWriteDirs: ['/tmp/my-workspace'],
    forbiddenExtensions: ['.exe', '.sh'],
  },
})

await ws.initialize()

// 执行命令
const result = await ws.execCommand('ls -la', 5000)
console.log(result.stdout)
console.log(result.exitCode)

// 文件操作
await ws.writeFile('test.txt', 'Hello World')
const file = await ws.readFile('test.txt')
console.log(file.content)  // "Hello World"

const exists = await ws.exists('test.txt')
console.log(exists.success)  // true

const dir = await ws.listFiles('.')
console.log(dir.files)

await ws.deleteFile('test.txt')
await ws.close()
```

### DockerWorkspace

在 Docker 容器中执行命令和文件操作。

```typescript
const ws = createWorkspace({
  type: 'docker',
  workDir: '/workspace',
  docker: {
    image: 'node:20',
    containerName: 'my-agent-workspace',
    volumes: ['/host/path:/workspace'],
    networkMode: 'host',
    env: { NODE_ENV: 'development' },
  },
  limits: {
    cpu: 2,
    memory: 512,
    timeout: 30000,
  },
})

await ws.initialize()  // 创建并启动容器

// 在容器内执行命令
const result = await ws.execCommand('node -e "console.log(1+1)"')

// 文件操作（自动使用 docker cp / docker exec）
await ws.writeFile('/workspace/app.js', 'console.log("hello")')
const file = await ws.readFile('/workspace/app.js')

await ws.close()  // 停止并删除容器
```

### WorkspaceConfig

```typescript
interface WorkspaceConfig {
  type: WorkspaceType                     // "local" | "docker" | "e2b"
  workDir: string                         // 工作目录
  limits?: {
    cpu?: number
    memory?: number                       // MB
    disk?: number                         // MB
    timeout?: number                      // ms
  }
  docker?: {
    image: string
    containerName?: string
    volumes?: string[]
    networkMode?: string
    env?: Record<string, string>
  }
  filesystem?: {
    allowedReadDirs?: string[]
    allowedWriteDirs?: string[]
    forbiddenExtensions?: string[]
  }
}
```

### CommandResult

```typescript
interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}
```

### FileResult

```typescript
interface FileResult {
  operation: FileOperation    // "read" | "write" | "delete" | "list" | "exists"
  path: string
  content?: string            // read 操作
  success: boolean
  files?: string[]            // list 操作
  error?: string
}
```

---

## 11. MCP 协议集成

MCP (Model Context Protocol) 实现了 JSON-RPC 2.0 over stdio 的工具互通协议。

### MCPClient

管理与单个 MCP 服务器的连接。

```typescript
import { MCPClient } from './src/index.js'

const client = new MCPClient({
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  env: { DEBUG: 'mcp:*' },
  timeout: 15000,
})

// 事件监听
client.on('connected', (event) => console.log('已连接:', event.serverName))
client.on('tools_changed', (event) => console.log('工具列表变更'))
client.on('error', (event) => console.error('错误:', event.data))

// 连接并自动发现
await client.connect()

// 查看发现的工具
console.log(client.tools)      // MCPToolInfo[]
console.log(client.resources)  // MCPResource[]
console.log(client.serverInfo) // MCPServerInfo

// 调用工具
const result = await client.callTool('read_file', { path: '/tmp/test.txt' })

// 读取资源
const resource = await client.readResource('file:///tmp/test.txt')

// 断开连接
await client.disconnect()
```

### MCPManager

管理多个 MCP 服务器的连接池。

```typescript
import { MCPManager, createMCPManager } from './src/index.js'

const manager = createMCPManager([
  {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  },
  {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'xxx' },
    enabled: true,
  },
])

// 连接所有服务器
await manager.connectAll()

// 获取聚合工具列表（自动添加 mcp__{server}__{tool} 前缀）
const allTools = manager.getAllTools()
// allTools[0].name === "mcp__filesystem__read_file"

// 获取聚合资源
const allResources = manager.getAllResources()

// 获取单个客户端
const fsClient = manager.getClient('filesystem')

// 查看连接状态
const connected = manager.getConnectedClients()

// 断开所有
await manager.disconnectAll()
```

### MCPServerConfig

```typescript
interface MCPServerConfig {
  name: string                // 唯一标识
  command: string             // 启动命令
  args?: string[]             // 命令参数
  env?: Record<string, string>  // 环境变量
  cwd?: string                // 工作目录
  timeout?: number            // 超时（默认 10000ms）
  enabled?: boolean           // 是否启用
}
```

### MCP 事件类型

```typescript
type MCPClientEventType =
  | "connected"
  | "disconnected"
  | "error"
  | "tools_changed"
  | "resources_changed"
  | "notification"
```

---

## 12. Token 计数

提供多种策略的 Token 计数功能。

```typescript
import { TokenCounter, countTokens } from './src/index.js'
import type { TokenizerType, TokenCountResult } from './src/index.js'

// 使用实例
const counter = new TokenCounter('claude')

// 计算文本 token 数
const tokens = counter.count('你好世界')         // Claude 估算
const gptTokens = counter.count('你好世界', 'gpt')  // GPT 估算

// 计算消息列表 token 数
const msgTokens = counter.countMessages(messages)

// 完整 usage 结果
const usage: TokenCountResult = counter.countWithUsage('输入文本', '输出文本')
// { total: 10, inputTokens: 6, outputTokens: 4, tokenizer: "claude" }

// 全局便利函数
const quick = countTokens('快速计数')
```

### 估算策略

| 编码器 | 中文策略 | 英文策略 | 其他 |
|--------|---------|---------|------|
| `simple` | 字符数 / 4 | 字符数 / 4 | 字符数 / 4 |
| `claude` | 1 字符 ≈ 1.5 token | 1 词 ≈ 1.3 token | 字符数 / 4 |
| `gpt` | 1 字符 ≈ 2 token | 1 词 ≈ 1.3 token | 字符数 / 4 |

---

## 13. ContentBlock 消息系统

基于 ContentBlock 数组的组合消息，支持文本、思考、工具调用、工具结果和数据块。

### ContentBlock 类型

```typescript
type ContentBlock =
  | TextBlock         // { type: "text", text: string }
  | ThinkingBlock     // { type: "thinking", thinking: string, signature?: string }
  | ToolCallBlock     // { type: "tool_call", toolName, toolInput, toolCallId }
  | ToolResultBlock   // { type: "tool_result", toolCallId, content, isError }
  | DataBlock         // { type: "data", mimeType, data }
```

### Msg 类

```typescript
import { Msg, msgToText, msgToAPIFormat } from './src/index.js'

// 创建纯文本消息
const textMsg = Msg.ofText('user', '你好')

// 创建工具调用消息
const toolCallMsg = Msg.ofToolCall('bash', { command: 'ls' }, 'call_1')

// 创建工具结果消息
const toolResultMsg = Msg.ofToolResult('call_1', 'file1.txt\nfile2.txt')

// 流式追加事件
const msg = new Msg('assistant')
msg.appendEvent({ type: 'content_delta', delta: 'Hello' })
msg.appendEvent({ type: 'content_delta', delta: ' World' })
msg.appendEvent({ type: 'tool_use', toolName: 'bash', toolInput: { command: 'ls' }, toolCallId: 'c1' })

// 转换
const text = msgToText(msg)          // 纯文本
const apiMsg = msgToAPIFormat(msg)   // 兼容 Message 格式
```

---

## 14. 存储提供者

### MemoryStorage

基于 Map 的内存存储，进程结束后数据丢失。

```typescript
import { MemoryStorage } from './src/index.js'

const storage = new MemoryStorage()

await storage.save('key1', { name: 'test' })
const data = await storage.load<{ name: string }>('key1')
await storage.delete('key1')
const keys = await storage.list('key')
await storage.clear()
console.log(storage.size)  // 条目数
```

### FileStorage

基于 JSON 文件的持久化存储。

```typescript
import { FileStorage } from './src/index.js'

const storage = new FileStorage('/data/storage')

await storage.save('session-1', { messages: [...] })
const session = await storage.load('session-1')
const allKeys = await storage.list()
const sessionKeys = await storage.list('session-')
const exists = await storage.has('session-1')
await storage.clear()
```

> **安全**：FileStorage 自动对 key 进行安全处理，防止路径穿越。

---

## 15. 事件系统

### EventBus

类型安全的事件总线，支持 `once` 和通配符。

```typescript
import { EventBusImpl as EventBus } from './src/index.js'

const bus = new EventBus()

// 注册监听
bus.on('agent:start', (payload) => {
  console.log('Agent 启动:', payload)
})

// 一次性监听
bus.once('agent:end', (payload) => {
  console.log('Agent 完成（仅触发一次）:', payload)
})

// 通配符监听所有事件
bus.on('*', (payload) => {
  console.log('收到事件:', payload)
})

// 发送事件
bus.emit('agent:start', { agentId: 'agent-1' })
bus.emit('agent:end', { agentId: 'agent-1', output: 'done' })

// 取消监听
bus.off('agent:start', handler)

// 移除指定事件的所有监听器
bus.removeAllListeners('agent:start')

// 查看监听器数量
const count = bus.listenerCount('agent:start')
```

### Framework 事件

```typescript
type FrameworkEventType =
  | "agent:start"
  | "agent:end"
  | "agent:error"
  | "orchestrator:start"
  | "orchestrator:end"
  | "tool:call"
  | "tool:result"

interface FrameworkEvent {
  type: FrameworkEventType
  timestamp: number
  data: Record<string, unknown>
}
```

---

## 16. 架构总览

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

### 目录结构

```
src/
├── index.ts                    # Framework 主入口 + 重导出
├── api.ts                      # 高层开发者 API
├── core/
│   ├── types.ts                # 核心类型定义
│   └── event-bus.ts            # 事件总线
├── runtime/
│   ├── agent-loop.ts           # 推理循环（State + Continue Sites）
│   ├── tool-executor.ts        # 工具并行编排
│   ├── context-manager.ts      # 上下文管理
│   ├── context-block.ts        # ContentBlock 消息系统
│   ├── middleware.ts           # 洋葱中间件 + HookRegistry
│   ├── permission.ts           # 权限引擎
│   ├── tool-group.ts           # 工具分组（Toolkit）
│   └── token-counter.ts        # Token 计数（运行时内部）
├── orchestrator/
│   └── index.ts                # 4 种编排模式
├── mcp/
│   ├── types.ts                # MCP 类型
│   ├── client.ts               # MCP 客户端
│   └── manager.ts              # MCP 管理器
├── provider/
│   ├── model/index.ts          # Model 抽象 + EchoModelProvider
│   ├── channel/index.ts        # Channel 抽象
│   ├── storage/index.ts        # 存储（Memory / File）
│   ├── workspace.ts            # 沙盒（Local / Docker）
│   └── mcp.ts                  # MCP Provider
└── utils/
    └── token-counter.ts        # Token 工具函数
```

---

## 17. API 速查表

### 高层 API

| API | 说明 | 返回 |
|-----|------|------|
| `createTool(config)` | 对象配置创建工具 | `ToolDef` |
| `createTool(name, desc, handler)` | 三参数创建工具 | `ToolDef` |
| `createAgent(config)` | 创建 Agent | `AgentDef` |
| `createApp(config)` | 创建应用 | `App` |
| `createMiddleware(name, handler)` | 创建中间件 | `{ name, fn }` |
| `createChannel('cli', config?)` | 创建 CLI 渠道 | `ChannelDef` |
| `createChannel('http', config)` | 创建 HTTP 渠道 | `ChannelDef` |
| `createChannel('custom', config)` | 创建自定义渠道 | `ChannelDef` |
| `createModel('claude', config)` | 创建 Claude 模型 | `ModelProvider` |
| `createModel('openai', config)` | 创建 OpenAI 模型 | `ModelProvider` |
| `createModel('custom', config)` | 创建自定义模型 | `ModelProvider` |
| `pipe(...agents)` | 顺序编排 | `Pipeline` |
| `parallel(...agents)` | 并行编排 | `Pipeline` |
| `toolbox(namespace, defs)` | 批量定义工具 | `ToolboxResult` |

### 底层 API

| API | 说明 |
|-----|------|
| `agentLoop(messages, options)` | 核心 AsyncGenerator 推理循环 |
| `new ToolExecutor(tools)` | 工具执行器 |
| `new ContextManager()` | 上下文管理器 |
| `new Toolkit()` | 工具管理器 |
| `new MiddlewarePipeline()` | 中间件管道 |
| `new HookRegistry()` | Hook 注册中心 |
| `new PermissionEngine()` | 权限引擎 |
| `new TokenCounter(tokenizer?)` | Token 计数器 |
| `new Framework()` | 框架核心类 |
| `createWorkspace(config)` | 创建工作空间 |
| `new MCPClient(config)` | MCP 客户端 |
| `new MCPManager()` / `createMCPManager(configs?)` | MCP 管理器 |
| `createOrchestrator(options)` | 创建编排器 |
| `new SequentialOrchestrator(def)` | 顺序编排器 |
| `new ParallelOrchestrator(def)` | 并行编排器 |
| `new RouterOrchestrator(def)` | 路由编排器 |
| `new SupervisorOrchestrator(def, supervisor)` | 监督者编排器 |
| `new EventBusImpl()` | 事件总线 |
| `new MemoryStorage()` | 内存存储 |
| `new FileStorage(baseDir)` | 文件存储 |
| `new EchoModelProvider(id?)` | Echo 测试模型 |

### 便捷工厂函数

| API | 说明 | 返回 |
|-----|------|------|
| `defineAgent(def)` | 定义 Agent | `AgentDef` |
| `defineTool(def)` | 定义 Tool | `ToolDef` |
| `defineChannel(def)` | 定义 Channel | `ChannelDef` |
| `defineOrchestrator(def)` | 定义 Orchestrator | `OrchestratorDef` |
| `countTokens(text, tokenizer?)` | 全局 Token 计数 | `number` |
