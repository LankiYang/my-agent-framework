/**
 * CLI Channel — 命令行交互渠道
 *
 * 使用 Node.js readline 模块读取 stdin，将用户输入分发给消息处理器，
 * 并将 Agent 回复输出到 stdout。支持 SIGINT 优雅退出。
 */

import readline from "node:readline";
import { BaseChannel } from "./index.js";
import type { Message } from "../../core/types.js";

/** CLI Channel 配置选项 */
export interface CLIChannelOptions {
  /** 命令提示符（默认 "> "） */
  prompt?: string;
  /** 退出命令（默认 ["exit", "quit"]） */
  exitCommands?: string[];
}

/**
 * CLI Channel 实现
 *
 * 功能：
 * - readline 读取 stdin 行输入
 * - 将输入包装为 user Message 并 dispatch
 * - Agent 回复通过 sendMessage 打印到 stdout
 * - 支持 exit/quit 命令和 SIGINT 优雅退出
 */
export class CLIChannel extends BaseChannel {
  private readonly promptStr: string;
  private readonly exitCommands: Set<string>;
  private rl: readline.Interface | null = null;

  constructor(options?: CLIChannelOptions) {
    super("channel-cli", "cli");
    this.promptStr = options?.prompt ?? "> ";
    this.exitCommands = new Set(options?.exitCommands ?? ["exit", "quit"]);
  }

  /** 启动 CLI：创建 readline 接口，监听行输入和 SIGINT */
  protected async doStart(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.promptStr,
      terminal: true,
    });

    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      if (this.exitCommands.has(trimmed.toLowerCase())) {
        this.stop().catch(() => {});
        return;
      }

      const message: Message = {
        id: `cli-msg-${Date.now()}`,
        role: "user",
        type: "text",
        content: trimmed,
        timestamp: Date.now(),
      };

      this.dispatch(message).then(() => {
        this.rl?.prompt();
      });
    });

    this.rl.on("SIGINT", () => {
      process.stdout.write("\n");
      this.stop().catch(() => {});
    });

    this.rl.on("close", () => {
      // readline 关闭时不做额外处理，由 stop() 统一管理
    });

    // 显示初始提示符
    this.rl.prompt();
  }

  /** 将 Agent 回复消息输出到 stdout */
  async sendMessage(message: Message): Promise<void> {
    if (message.role === "assistant" || message.role === "system") {
      process.stdout.write(`${message.content}\n`);
    }
  }

  /** 停止 CLI：关闭 readline 接口 */
  protected async doStop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
