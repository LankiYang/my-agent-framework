import type { EventBus } from "./types.js";

/** 事件处理器函数类型 */
type EventHandler = (payload?: unknown) => void;

/**
 * 类型安全的事件总线实现
 * 支持 once（一次性监听）和 wildcard（通配符匹配 "*"）
 */
export class EventBusImpl implements EventBus {
  /** 事件 -> 处理器集合的映射 */
  private handlers = new Map<string, Set<EventHandler>>();
  /** 记录只触发一次的处理器 */
  private onceHandlers = new WeakSet<EventHandler>();

  /** 发送事件，触发所有匹配的处理器（精确匹配 + 通配符） */
  emit(event: string, payload?: unknown): void {
    // 触发精确匹配的处理器
    this.invokeHandlers(event, payload);

    // 触发通配符 "*" 的处理器（不重复触发自身）
    if (event !== "*") {
      this.invokeHandlers("*", payload);
    }
  }

  /** 注册事件监听器 */
  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  /** 取消事件监听器 */
  off(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  /** 注册一次性事件监听器，触发一次后自动移除 */
  once(event: string, handler: EventHandler): void {
    const wrappedHandler: EventHandler = (payload) => {
      this.off(event, wrappedHandler);
      handler(payload);
    };
    this.onceHandlers.add(wrappedHandler);
    this.on(event, wrappedHandler);
  }

  /** 移除指定事件的所有监听器，不传参则清空所有事件 */
  removeAllListeners(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  /** 获取指定事件的监听器数量 */
  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  /** 内部方法：调用指定事件名下的所有处理器 */
  private invokeHandlers(event: string, payload?: unknown): void {
    const set = this.handlers.get(event);
    if (!set) return;

    // 拷贝一份以防止在遍历过程中被修改（once 会在回调中移除自身）
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] 事件 "${event}" 的处理器抛出异常:`, err);
      }
    }
  }
}
