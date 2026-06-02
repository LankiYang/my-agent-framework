/**
 * 权限引擎
 * 参考 AgentScope 的 permission 设计，实现链式权限评估
 */

import type { ToolInput, SharedContext, ToolDef } from "../core/types.js";

// ============================================================
// 权限枚举
// ============================================================

/** 权限评估结果等级 */
export enum PermissionLevel {
  Allowed = "allowed",
  Denied = "denied",
  Ask = "ask",
  Bypass = "bypass",
}

/** 权限模式：控制整体权限行为 */
export enum PermissionMode {
  Default = "default",
  AcceptEdits = "accept_edits",
  Explore = "explore",
  Bypass = "bypass",
  DontAsk = "dont_ask",
}

// ============================================================
// 权限上下文与规则定义
// ============================================================

/** 权限评估上下文 */
export interface PermissionContext {
  mode: PermissionMode;
  toolName: string;
  input: ToolInput;
  metadata: Record<string, unknown>;
}

/** 权限规则定义 */
export interface PermissionRule {
  name: string;
  priority: number;
  evaluate(ctx: PermissionContext): PermissionLevel | null;
  description?: string;
}

// ============================================================
// 工具判断辅助
// ============================================================

/** 判断工具是否为破坏性操作（产生副作用） */
function isDestructiveTool(toolDef?: ToolDef): boolean {
  if (!toolDef) return true;
  return toolDef.isReadOnly !== true;
}

// ============================================================
// 权限引擎
// ============================================================

/**
 * 权限引擎
 *
 * 按优先级执行规则链，支持：
 * - 动态添加/移除规则
 * - 内置默认规则（deny / allow / ask）
 * - 快捷检查工具权限
 */
export class PermissionEngine {
  private rules: PermissionRule[] = [];

  constructor() {
    this.initDefaultRules();
  }

  /**
   * 初始化内置默认规则
   *
   * 规则链（按优先级排列）：
   * 1. deny 规则（priority: 0）— BYPASS mode 以外，拒绝 EXPLORE 模式下的写操作
   * 2. allow 规则（priority: 1）— BYPASS mode 允许所有
   * 3. ask 规则（priority: 2）— 非 BYPASS 模式下，破坏性工具需要 ask
   */
  private initDefaultRules(): void {
    this.addRule({
      name: "builtin:deny",
      priority: 0,
      description: "EXPLORE 模式下拒绝写操作",
      evaluate: (ctx) => {
        if (ctx.mode === PermissionMode.Bypass) {
          return null;
        }
        if (ctx.mode === PermissionMode.Explore) {
          const toolDef = ctx.metadata.toolDef as ToolDef | undefined;
          if (isDestructiveTool(toolDef)) {
            return PermissionLevel.Denied;
          }
        }
        return null;
      },
    });

    this.addRule({
      name: "builtin:allow",
      priority: 1,
      description: "BYPASS 模式允许所有操作",
      evaluate: (ctx) => {
        if (ctx.mode === PermissionMode.Bypass) {
          return PermissionLevel.Allowed;
        }
        return null;
      },
    });

    this.addRule({
      name: "builtin:ask",
      priority: 2,
      description: "非 BYPASS 模式下破坏性操作需要用户确认",
      evaluate: (ctx) => {
        if (ctx.mode === PermissionMode.Bypass) {
          return null;
        }
        if (ctx.mode === PermissionMode.DontAsk) {
          return null;
        }
        const toolDef = ctx.metadata.toolDef as ToolDef | undefined;
        if (isDestructiveTool(toolDef)) {
          return PermissionLevel.Ask;
        }
        return null;
      },
    });
  }

  /**
   * 添加规则
   * 插入后按 priority 重新排序
   */
  addRule(rule: PermissionRule): void {
    const existing = this.rules.findIndex((r) => r.name === rule.name);
    if (existing !== -1) {
      this.rules[existing] = rule;
    } else {
      this.rules.push(rule);
    }
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 移除规则
   * 内置规则（以 builtin: 开头）也可被移除
   */
  removeRule(name: string): void {
    this.rules = this.rules.filter((r) => r.name !== name);
  }

  /**
   * 按优先级执行规则链
   *
   * 处理流程：
   * 1. 依次执行每条规则，遇到非 null 结果则返回
   * 2. 所有规则均跳过时，返回默认值
   * 3. DontAsk 模式下，Ask 结果转为 Denied
   */
  evaluate(ctx: PermissionContext): PermissionLevel {
    for (const rule of this.rules) {
      const result = rule.evaluate(ctx);
      if (result !== null) {
        if (result === PermissionLevel.Ask && ctx.mode === PermissionMode.DontAsk) {
          return PermissionLevel.Denied;
        }
        return result;
      }
    }

    return this.getDefaultResult(ctx.mode);
  }

  /**
   * 获取当前模式下的默认权限结果
   */
  private getDefaultResult(mode: PermissionMode): PermissionLevel {
    switch (mode) {
      case PermissionMode.Bypass:
        return PermissionLevel.Allowed;
      case PermissionMode.Explore:
        return PermissionLevel.Allowed;
      case PermissionMode.AcceptEdits:
        return PermissionLevel.Allowed;
      case PermissionMode.DontAsk:
        return PermissionLevel.Denied;
      case PermissionMode.Default:
      default:
        return PermissionLevel.Ask;
    }
  }

  /**
   * 快捷方法：检查某个工具的权限
   *
   * @param toolName - 工具名称
   * @param input - 工具输入参数
   * @param tools - 可用工具列表（用于查找 ToolDef 判断 isReadOnly）
   * @param mode - 权限模式
   * @param extraMetadata - 额外元数据
   */
  checkToolPermission(
    toolName: string,
    input: ToolInput,
    tools: ToolDef[],
    mode: PermissionMode,
    extraMetadata: Record<string, unknown> = {},
  ): PermissionLevel {
    const toolDef = tools.find((t) => t.name === toolName);

    const ctx: PermissionContext = {
      mode,
      toolName,
      input,
      metadata: {
        ...extraMetadata,
        toolDef,
      },
    };

    return this.evaluate(ctx);
  }

  /** 获取当前所有规则（按优先级排列） */
  getRules(): ReadonlyArray<PermissionRule> {
    return [...this.rules];
  }
}
