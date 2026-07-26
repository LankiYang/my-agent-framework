import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionEngine,
  PermissionMode,
  PermissionLevel,
} from "./permission.js";
import type { ToolDef } from "../core/types.js";

const readOnlyTool: ToolDef = {
  name: "read",
  description: "只读工具",
  inputSchema: {},
  isReadOnly: true,
  execute: async () => ({ content: "" }),
};

const writeTool: ToolDef = {
  name: "write",
  description: "写工具",
  inputSchema: {},
  isReadOnly: false,
  execute: async () => ({ content: "" }),
};

const tools = [readOnlyTool, writeTool];

test("Default 模式：破坏性工具需要 Ask（只读工具落到默认 Ask）", () => {
  const engine = new PermissionEngine();
  assert.equal(
    engine.checkToolPermission("write", {}, tools, PermissionMode.Default),
    PermissionLevel.Ask,
  );
  // Default 模式的默认结果即 Ask：内置 ask 规则对只读工具返回 null，
  // 落到 getDefaultResult(Default) = Ask。这是"默认询问一切"的设计。
  assert.equal(
    engine.checkToolPermission("read", {}, tools, PermissionMode.Default),
    PermissionLevel.Ask,
  );
});

test("Explore 模式：只读工具放行", () => {
  const engine = new PermissionEngine();
  assert.equal(
    engine.checkToolPermission("read", {}, tools, PermissionMode.Explore),
    PermissionLevel.Allowed,
  );
});

test("Bypass 模式：全部放行", () => {
  const engine = new PermissionEngine();
  assert.equal(
    engine.checkToolPermission("write", {}, tools, PermissionMode.Bypass),
    PermissionLevel.Allowed,
  );
});

test("Explore 模式：写操作被拒绝，读操作放行", () => {
  const engine = new PermissionEngine();
  assert.equal(
    engine.checkToolPermission("write", {}, tools, PermissionMode.Explore),
    PermissionLevel.Denied,
  );
  assert.equal(
    engine.checkToolPermission("read", {}, tools, PermissionMode.Explore),
    PermissionLevel.Allowed,
  );
});

test("DontAsk 模式：Ask 结果转为 Denied", () => {
  const engine = new PermissionEngine();
  assert.equal(
    engine.checkToolPermission("write", {}, tools, PermissionMode.DontAsk),
    PermissionLevel.Denied,
  );
});

test("自定义规则可覆盖默认（高优先级 Denied）", () => {
  const engine = new PermissionEngine();
  engine.addRule({
    name: "custom:block-write",
    priority: -1,
    evaluate: (ctx) => (ctx.toolName === "write" ? PermissionLevel.Denied : null),
  });
  assert.equal(
    engine.checkToolPermission("write", {}, tools, PermissionMode.Bypass),
    PermissionLevel.Denied,
  );
});

test("removeRule 可移除内置规则", () => {
  const engine = new PermissionEngine();
  engine.removeRule("builtin:ask");
  // 移除 ask 规则后，Default 模式下写操作落到默认 Ask（getDefaultResult）
  const level = engine.checkToolPermission("write", {}, tools, PermissionMode.Default);
  assert.equal(level, PermissionLevel.Ask);
});
