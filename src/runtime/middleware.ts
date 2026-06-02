/**
 * 洋葱模型中间件系统
 *
 * 参考 AgentScope middleware 设计，实现基于洋葱模型（Onion Model）的中间件管道，
 * 支持在请求处理的前后阶段进行拦截和增强。
 *
 * 执行顺序示例：
 *   中间件A(前) → 中间件B(前) → 核心逻辑 → 中间件B(后) → 中间件A(后)
 */

import type {
  Message,
  ToolCall,
  ToolInput,
  ToolDef,
  EventBus,
} from "../core/types.js";

// ============================================================
// 核心类型定义
// ============================================================

/** 中间件上下文：在中间件链中传递的状态对象 */
export interface MiddlewareContext {
  /** 对话消息列表 */
  messages: Message[];
  /** 系统提示词 */
  systemPrompt: string;
  /** 可用工具列表 */
  tools: ToolDef[];
  /** Agent 唯一标识 */
  agentId: string;
  /** 事件总线实例（可选） */
  eventBus?: EventBus;
  /** 允许扩展任意属性 */
  [key: string]: unknown;
}

/** 下一个中间件函数类型 */
export type NextFn<T = void> = (modifiedContext?: MiddlewareContext) => Promise<T>;

/** 中间件函数类型 — 洋葱模型，支持前后拦截 */
export type MiddlewareFn = (
  context: MiddlewareContext,
  next: NextFn,
) => Promise<void>;

/** 变换型钩子函数类型（管道模式，顺序变换） */
export type TransformHookFn<T> = (value: T, context: MiddlewareContext) => T | Promise<T>;

// ============================================================
// 中间件管道
// ============================================================

/**
 * 中间件管道
 *
 * 按注册顺序将中间件组合成洋葱结构的执行链。
 * 每个中间件在调用 next() 之前的代码在"入站"阶段执行，
 * 在 next() 之后的代码在"出站"阶段执行。
 */
export class MiddlewarePipeline {
  private middlewares: MiddlewareFn[] = [];

  /** 注册中间件到管道末尾 */
  use(fn: MiddlewareFn): void {
    this.middlewares.push(fn);
  }

  /** 按洋葱顺序执行所有中间件，返回被修改后的 context */
  async run(context: MiddlewareContext): Promise<MiddlewareContext> {
    await this.compose(this.middlewares)(context, async () => {});
    return context;
  }

  /** 组合中间件为单一的洋葱执行函数 */
  private compose(middlewares: MiddlewareFn[]): MiddlewareFn {
    return async (context, next?) => {
      const finalNext = next ?? (async () => {});
      let index = -1;

      const dispatch = async (i: number): Promise<void> => {
        if (i <= index) {
          throw new Error("next() 不允许被多次调用");
        }
        index = i;

        if (i >= middlewares.length) {
          await finalNext(context);
          return;
        }

        await middlewares[i](context, async (modifiedContext) => {
          if (modifiedContext) {
            Object.assign(context, modifiedContext);
          }
          await dispatch(i + 1);
        });
      };

      await dispatch(0);
    };
  }
}

// ============================================================
// Hook 点定义
// ============================================================

/** 中间件 Hook 触发点枚举 */
export enum HookPoint {
  /** 拦截整个回复过程（前后） */
  onReply = "on_reply",
  /** 拦截推理/模型调用阶段（前后） */
  onReasoning = "on_reasoning",
  /** 拦截单次工具执行（前后） */
  onActing = "on_acting",
  /** 拦截原始模型 API 调用（前后） */
  onModelCall = "on_model_call",
  /** 管道模式转换系统提示词（顺序变换，非洋葱） */
  onSystemPrompt = "on_system_prompt",
}

// ============================================================
// Hook 注册中心
// ============================================================

/**
 * Hook 注册中心
 *
 * 管理两种类型的钩子：
 * 1. 洋葱模型中间件钩子 — 通过 register/apply 管理，支持前后拦截
 * 2. 管道模型变换钩子 — 通过 registerTransform/applyTransform 管理，顺序变换值
 */
export class HookRegistry {
  /** 洋葱模型中间件钩子存储 */
  private hooks = new Map<HookPoint, MiddlewareFn[]>();
  /** 管道模型变换钩子存储 */
  private transformHooks = new Map<HookPoint, TransformHookFn<unknown>[]>();

  /** 注册一个洋葱模型中间件钩子 */
  register(hookPoint: HookPoint, fn: MiddlewareFn): void {
    if (!this.hooks.has(hookPoint)) {
      this.hooks.set(hookPoint, []);
    }
    this.hooks.get(hookPoint)!.push(fn);
  }

  /**
   * 执行指定 Hook 点的所有中间件（洋葱模型）
   * 按注册顺序组合成洋葱链并执行
   */
  async apply(hookPoint: HookPoint, context: MiddlewareContext): Promise<void> {
    const middlewares = this.hooks.get(hookPoint);
    if (!middlewares || middlewares.length === 0) return;

    const pipeline = new MiddlewarePipeline();
    for (const middleware of middlewares) {
      pipeline.use(middleware);
    }
    await pipeline.run(context);
  }

  /** 注册一个管道模型变换钩子 */
  registerTransform<T>(hookPoint: HookPoint, fn: TransformHookFn<T>): void {
    if (!this.transformHooks.has(hookPoint)) {
      this.transformHooks.set(hookPoint, []);
    }
    this.transformHooks.get(hookPoint)!.push(fn as TransformHookFn<unknown>);
  }

  /**
   * 执行指定 Hook 点的所有变换钩子（管道模型）
   * 按注册顺序依次变换值，前一个的输出作为后一个的输入
   */
  async applyTransform<T>(hookPoint: HookPoint, value: T, context: MiddlewareContext): Promise<T> {
    const fns = this.transformHooks.get(hookPoint) as TransformHookFn<T>[] | undefined;
    if (!fns || fns.length === 0) return value;

    let result = value;
    for (const fn of fns) {
      result = await fn(result, context);
    }
    return result;
  }

  /** 清除指定 Hook 点的所有钩子，不传参则清空全部 */
  clear(hookPoint?: HookPoint): void {
    if (hookPoint) {
      this.hooks.delete(hookPoint);
      this.transformHooks.delete(hookPoint);
    } else {
      this.hooks.clear();
      this.transformHooks.clear();
    }
  }
}

// ============================================================
// 便捷工厂函数
// ============================================================

/**
 * 创建带名称的中间件
 *
 * @param name - 中间件名称（用于日志/调试）
 * @param fn - 中间件函数
 * @returns 包含名称和中间件函数的对象
 */
export function createMiddleware(
  name: string,
  fn: MiddlewareFn,
): { name: string; fn: MiddlewareFn } {
  return { name, fn };
}
