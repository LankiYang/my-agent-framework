/**
 * Storage Provider 模块
 * 提供内存存储和文件存储两种实现
 */

import { readFile, writeFile, readdir, unlink, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { StorageProvider } from "../../core/types.js";

// ============ 内存存储 ============

/**
 * MemoryStorage
 * 基于 Map 的内存存储实现，数据在进程结束后丢失
 */
export class MemoryStorage implements StorageProvider {
  private store: Map<string, unknown> = new Map();

  async save(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async load<T = unknown>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    return value !== undefined ? (value as T) : null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const allKeys = [...this.store.keys()];
    if (!prefix) {
      return allKeys;
    }
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  /** 清空所有数据 */
  async clear(): Promise<void> {
    this.store.clear();
  }

  /** 获取存储条目数 */
  get size(): number {
    return this.store.size;
  }
}

// ============ 文件存储 ============

/**
 * FileStorage
 * 基于 JSON 文件的持久化存储实现
 * 每个 key 对应一个独立的 JSON 文件
 */
export class FileStorage implements StorageProvider {
  private readonly baseDir: string;
  private initialized = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** 确保存储目录存在 */
  private async ensureDir(): Promise<void> {
    if (this.initialized) {
      return;
    }
    try {
      await mkdir(this.baseDir, { recursive: true });
    } catch {
      // 目录已存在时忽略
    }
    this.initialized = true;
  }

  /** 获取 key 对应的文件路径 */
  private getFilePath(key: string): string {
    // 对 key 进行安全处理，避免路径穿越
    const safeKey = key.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    return join(this.baseDir, `${safeKey}.json`);
  }

  async save(key: string, value: unknown): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(key);
    const content = JSON.stringify({ key, value, updatedAt: Date.now() }, null, 2);
    await writeFile(filePath, content, "utf-8");
  }

  async load<T = unknown>(key: string): Promise<T | null> {
    const filePath = this.getFilePath(key);
    try {
      const content = await readFile(filePath, "utf-8");
      const wrapper = JSON.parse(content) as { value: T };
      return wrapper.value;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    try {
      await unlink(filePath);
    } catch {
      // 文件不存在时忽略
    }
  }

  async list(prefix?: string): Promise<string[]> {
    await this.ensureDir();
    try {
      const files = await readdir(this.baseDir);
      const keys = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));

      if (!prefix) {
        return keys;
      }
      return keys.filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  }

  /** 检查 key 是否存在 */
  async has(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** 清空所有存储文件 */
  async clear(): Promise<void> {
    const allKeys = await this.list();
    await Promise.all(allKeys.map((key) => this.delete(key)));
  }
}
