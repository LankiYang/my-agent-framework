/**
 * 工具分组管理
 * 参考 AgentScope 的 Toolkit 和 ToolGroup 设计
 */

import type { ToolDef, ToolInput, ToolOutput, SharedContext } from "../core/types.js";

// ============================================================
// 工具分组
// ============================================================

/**
 * ToolGroup — 工具分组
 *
 * 将相关工具归为一组，统一控制可用性
 */
export class ToolGroup {
  /** 分组名称 */
  name: string;
  /** 分组描述 */
  description: string;
  /** 该分组下的工具列表 */
  tools: ToolDef[];
  /** 是否激活 */
  active: boolean;

  constructor(
    name: string,
    tools: ToolDef[],
    description: string = "",
    active: boolean = true,
  ) {
    this.name = name;
    this.tools = [...tools];
    this.description = description;
    this.active = active;
  }

  /** 激活分组 */
  activate(): void {
    this.active = true;
  }

  /** 停用分组 */
  deactivate(): void {
    this.active = false;
  }
}

// ============================================================
// 工具过滤器
// ============================================================

/** 工具过滤器函数类型 */
export type ToolFilter = (tool: ToolDef) => boolean;

/**
 * 按类别过滤工具
 * 通过匹配工具名称前缀来推断类别
 *
 * @param category - 类别名称（如 "file"、"bash"、"search"）
 * @returns 匹配该类别的过滤函数
 *
 * @example
 * const fileTools = toolkit.filterTools(getToolsByCategory("file"));
 */
export function getToolsByCategory(category: string): ToolFilter {
  const prefix = `${category}_`;
  return (tool: ToolDef) =>
    tool.name.startsWith(prefix) ||
    tool.name.startsWith(`category:${category}`);
}

// ============================================================
// 工具管理器
// ============================================================

/**
 * Toolkit — 统一的工具管理器
 *
 * 职责：
 * - 注册/移除工具
 * - 创建/管理分组
 * - 按分组过滤获取可用工具
 * - 工具调用（查找 + 执行 + 错误包装）
 */
export class Toolkit {
  /** 全局工具注册表 */
  private tools: Map<string, ToolDef> = new Map();

  /** 分组列表 */
  private groups: Map<string, ToolGroup> = new Map();

  /** 工具所属分组的映射（工具名 → 组名列表） */
  private toolGroupMembership: Map<string, string[]> = new Map();

  // ============ 工具注册 ============

  /**
   * 注册单个工具
   */
  registerTool(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 批量注册工具
   */
  registerTools(tools: ToolDef[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * 移除工具
   * 从全局注册表和所有分组中移除
   */
  removeTool(name: string): void {
    this.tools.delete(name);

    const groups = this.toolGroupMembership.get(name);
    if (groups) {
      for (const groupName of groups) {
        const group = this.groups.get(groupName);
        if (group) {
          group.tools = group.tools.filter((t) => t.name !== name);
        }
      }
      this.toolGroupMembership.delete(name);
    }
  }

  // ============ 分组管理 ============

  /**
   * 创建分组
   *
   * @param name - 分组名称
   * @param toolNames - 分组包含的工具名称列表（必须在之前已注册）
   * @param description - 分组描述
   * @returns 创建的 ToolGroup 实例
   * @throws 如果引用了未注册的工具
   */
  createGroup(
    name: string,
    toolNames: string[],
    description: string = "",
  ): ToolGroup {
    const tools: ToolDef[] = [];
    for (const toolName of toolNames) {
      const tool = this.tools.get(toolName);
      if (!tool) {
        throw new Error(
          `创建分组 "${name}" 失败：工具 "${toolName}" 尚未注册`,
        );
      }
      tools.push(tool);
    }

    for (const tool of tools) {
      const groups = this.toolGroupMembership.get(tool.name) || [];
      groups.push(name);
      this.toolGroupMembership.set(tool.name, groups);
    }

    const group = new ToolGroup(name, tools, description);
    this.groups.set(name, group);
    return group;
  }

  /**
   * 获取分组
   */
  getGroup(name: string): ToolGroup | undefined {
    return this.groups.get(name);
  }

  /**
   * 激活分组
   */
  activateGroup(name: string): void {
    const group = this.groups.get(name);
    if (group) {
      group.activate();
    }
  }

  /**
   * 停用分组
   */
  deactivateGroup(name: string): void {
    const group = this.groups.get(name);
    if (group) {
      group.deactivate();
    }
  }

  /**
   * 移除分组
   * 仅移除分组定义，组内工具保留在全局注册表中
   */
  removeGroup(name: string): void {
    const group = this.groups.get(name);
    if (group) {
      for (const tool of group.tools) {
        const groups = this.toolGroupMembership.get(tool.name);
        if (groups) {
          const filtered = groups.filter((g) => g !== name);
          if (filtered.length === 0) {
            this.toolGroupMembership.delete(tool.name);
          } else {
            this.toolGroupMembership.set(tool.name, filtered);
          }
        }
      }
      this.groups.delete(name);
    }
  }

  // ============ 工具查询 ============

  /**
   * 获取当前所有可用工具
   *
   * 规则：
   * - 属于至少一个激活分组的工具 → 可用
   * - 不属于任何分组的独立工具 → 始终可用
   * - 仅属于未激活分组的工具 → 不可用
   */
  getAllTools(): ToolDef[] {
    const activatedToolNames = new Set<string>();

    for (const group of this.groups.values()) {
      if (group.active) {
        for (const tool of group.tools) {
          activatedToolNames.add(tool.name);
        }
      }
    }

    const result: ToolDef[] = [];

    for (const [name, tool] of this.tools) {
      const belongsToGroups = this.toolGroupMembership.get(name);
      const isUngrouped = !belongsToGroups || belongsToGroups.length === 0;

      if (isUngrouped || activatedToolNames.has(name)) {
        result.push(tool);
      }
    }

    return result;
  }

  /**
   * 按名称查找工具
   */
  getTool(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  /**
   * 使用过滤器筛选工具
   */
  filterTools(filter: ToolFilter): ToolDef[] {
    return this.getAllTools().filter(filter);
  }

  // ============ 工具调用 ============

  /**
   * 调用工具
   *
   * 流程：查找工具 → 执行 → 错误包装
   *
   * @param name - 工具名称
   * @param input - 输入参数
   * @param context - 共享上下文
   * @returns 工具执行结果
   * @throws 工具未找到错误
   */
  async callTool(
    name: string,
    input: ToolInput,
    context: SharedContext,
  ): Promise<ToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`工具 "${name}" 未注册`);
    }

    try {
      return await tool.execute(input, context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`工具 "${name}" 执行失败: ${msg}`);
    }
  }

  /** 获取所有分组名称 */
  getGroupNames(): string[] {
    return Array.from(this.groups.keys());
  }

  /** 获取所有已注册的工具名称 */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
