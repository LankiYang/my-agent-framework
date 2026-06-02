/**
 * Channel Provider 模块
 * 提供频道通信的抽象基类和类型导出
 */

import type {
  ChannelDef,
  Message,
} from "../../core/types.js";

// ============ 重导出 ChannelDef 类型 ============

export type { ChannelDef } from "../../core/types.js";

// ============ 频道消息处理器类型 ============

/** 频道消息事件处理函数 */
export type ChannelMessageHandler = (message: Message) => Promise<void>;

// ============ 基础频道抽象类 ============

/**
 * BaseChannel 抽象类
 * 管理频道生命周期和消息分发
 */
export abstract class BaseChannel implements ChannelDef {
  readonly id: string;
  readonly type: string;

  private handlers: Set<ChannelMessageHandler> = new Set();
  private started = false;

  constructor(id: string, type: string) {
    this.id = id;
    this.type = type;
  }

  /** 是否已启动 */
  get isStarted(): boolean {
    return this.started;
  }

  /** 注册消息处理器 */
  onMessage(handler: ChannelMessageHandler): void {
    this.handlers.add(handler);
  }

  /** 移除消息处理器 */
  offMessage(handler: ChannelMessageHandler): void {
    this.handlers.delete(handler);
  }

  /** 启动频道 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.doStart();
    this.started = true;
  }

  /** 停止频道 */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.doStop();
    this.started = false;
  }

  /** 发送消息到频道 */
  abstract sendMessage(message: Message): Promise<void>;

  /** 子类实现具体的启动逻辑 */
  protected abstract doStart(): Promise<void>;

  /** 子类实现具体的停止逻辑 */
  protected abstract doStop(): Promise<void>;

  /** 分发收到的消息给所有处理器 */
  protected async dispatch(message: Message): Promise<void> {
    const tasks = [...this.handlers].map((handler) => handler(message));
    await Promise.allSettled(tasks);
  }
}
