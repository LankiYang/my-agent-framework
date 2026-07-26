/**
 * 会话管理器（SessionManager）
 *
 * 让一个 Framework 实例能同时服务多个独立会话/用户：
 * 每个 sessionId 维护自己的消息历史，互不干扰。这是"服务端多用户"的地基。
 *
 * 设计：
 * - 注册表（agents/tools/models）仍由 Framework 共享（只读）；
 * - 运行状态（消息历史）按 sessionId 隔离，存于此处；
 * - 可选注入 StorageProvider 做持久化，支持跨进程恢复。
 */

import type { Message, Session, StorageProvider } from "../core/types.js";

/** 持久化时的 key 前缀 */
const SESSION_KEY_PREFIX = "session:";

export interface SessionManagerOptions {
  /** 可选的持久化后端；提供后会话读写会同步到存储 */
  storage?: StorageProvider;
}

/**
 * 会话管理器：内存态为主，可选持久化。
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private storage?: StorageProvider;

  constructor(options: SessionManagerOptions = {}) {
    this.storage = options.storage;
  }

  private key(sessionId: string): string {
    return `${SESSION_KEY_PREFIX}${sessionId}`;
  }

  /**
   * 获取会话；内存没有时尝试从存储加载。不存在返回 undefined。
   */
  async get(sessionId: string): Promise<Session | undefined> {
    const inMemory = this.sessions.get(sessionId);
    if (inMemory) return inMemory;

    if (this.storage) {
      const loaded = await this.storage.load<Session>(this.key(sessionId));
      if (loaded) {
        this.sessions.set(sessionId, loaded);
        return loaded;
      }
    }
    return undefined;
  }

  /**
   * 获取或创建会话。创建时记录 userId 与时间戳。
   */
  async getOrCreate(sessionId: string, userId?: string): Promise<Session> {
    const existing = await this.get(sessionId);
    if (existing) return existing;

    const now = Date.now();
    const session: Session = {
      id: sessionId,
      messages: [],
      metadata: {},
      userId,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    await this.persist(session);
    return session;
  }

  /**
   * 向会话追加消息并更新时间戳，同步持久化。
   */
  async append(sessionId: string, messages: Message[]): Promise<void> {
    const session = await this.getOrCreate(sessionId);
    session.messages.push(...messages);
    session.updatedAt = Date.now();
    await this.persist(session);
  }

  /**
   * 用给定消息列表整体替换会话历史（用于回填 agentLoop 产出的完整历史）。
   */
  async replaceMessages(sessionId: string, messages: Message[], userId?: string): Promise<void> {
    const session = await this.getOrCreate(sessionId, userId);
    session.messages = messages;
    session.updatedAt = Date.now();
    await this.persist(session);
  }

  /** 返回会话的消息历史副本；无会话返回空数组 */
  async getMessages(sessionId: string): Promise<Message[]> {
    const session = await this.get(sessionId);
    return session ? [...session.messages] : [];
  }

  /** 删除会话（内存 + 存储） */
  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    if (this.storage) {
      await this.storage.delete(this.key(sessionId));
    }
  }

  /**
   * 列出会话 ID；可选按 userId 过滤（仅对已加载/内存中的会话精确过滤）。
   */
  async list(userId?: string): Promise<string[]> {
    // 合并内存与存储中的会话 ID
    const ids = new Set<string>(this.sessions.keys());
    if (this.storage) {
      const keys = await this.storage.list(SESSION_KEY_PREFIX);
      for (const k of keys) {
        ids.add(k.startsWith(SESSION_KEY_PREFIX) ? k.slice(SESSION_KEY_PREFIX.length) : k);
      }
    }
    if (!userId) return [...ids];

    // 按 userId 过滤：需要加载会话确认归属
    const filtered: string[] = [];
    for (const id of ids) {
      const s = await this.get(id);
      if (s?.userId === userId) filtered.push(id);
    }
    return filtered;
  }

  /** 内存中会话数量 */
  size(): number {
    return this.sessions.size;
  }

  private async persist(session: Session): Promise<void> {
    if (this.storage) {
      await this.storage.save(this.key(session.id), session);
    }
  }
}
