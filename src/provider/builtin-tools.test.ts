import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadTool, createWriteTool, createBashTool } from "./builtin-tools.js";
import type { ExecutionEnv, ExecResult } from "./env.js";
import type { SharedContext } from "../core/types.js";

/** 记录调用的 Mock 环境 */
class MockEnv implements ExecutionEnv {
  readonly cwd = "/mock";
  files = new Map<string, string>();
  execLog: string[] = [];

  async readTextFile(p: string): Promise<string> {
    const f = this.files.get(p);
    if (f === undefined) throw new Error(`no such file: ${p}`);
    return f;
  }
  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(p, content);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
  async listDir(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async exec(command: string): Promise<ExecResult> {
    this.execLog.push(command);
    return { stdout: `ran: ${command}`, stderr: "", exitCode: 0 };
  }
}

function ctx(env: ExecutionEnv): SharedContext {
  return { messages: [], artifacts: {}, metadata: {}, env };
}

test("read 工具经 env 读取，不碰真实文件系统", async () => {
  const env = new MockEnv();
  env.files.set("a.txt", "hello world");
  const out = await createReadTool().execute({ path: "a.txt" }, ctx(env));
  assert.equal(out.content, "hello world");
});

test("read 工具：文件不存在返回错误信息（不抛）", async () => {
  const env = new MockEnv();
  const out = await createReadTool().execute({ path: "missing.txt" }, ctx(env));
  assert.match(out.content, /读取失败/);
});

test("write 工具经 env 写入", async () => {
  const env = new MockEnv();
  const out = await createWriteTool().execute({ path: "b.txt", content: "data" }, ctx(env));
  assert.match(out.content, /已写入/);
  assert.equal(env.files.get("b.txt"), "data");
});

test("bash 工具经 env 执行并回显 stdout", async () => {
  const env = new MockEnv();
  const out = await createBashTool().execute({ command: "ls -la" }, ctx(env));
  assert.match(out.content, /ran: ls -la/);
  assert.deepEqual(env.execLog, ["ls -la"]);
});

test("write 工具标记为非只读、bash 非并发安全", () => {
  assert.equal(createWriteTool().isReadOnly, false);
  assert.equal(createBashTool().isConcurrencySafe, false);
  assert.equal(createReadTool().isReadOnly, true);
});
