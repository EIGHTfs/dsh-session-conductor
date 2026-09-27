#!/usr/bin/env node
/**
 * detect-registered-tools.mjs — 列出本插件注册的 AI 工具（留档用，不调用）
 *
 * 静态解析 lib/index.js 中 `tools.register(defineTool({...}))` 的工具定义，
 * 输出 JSON 数组（name / description / parameters / output）。纯文本解析，
 * 不 import index.js（避免加载插件产生副作用），不上报 execute/内部实现。
 *
 * 用法：node tools/detect-registered-tools.mjs [--pretty]
 * 输出：JSON 数组，每项 = 一个注册工具的可读描述。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(resolve(root, "lib", "index.js"), "utf8");

const pretty = process.argv.includes("--pretty");

/** 提取对象字面量（如 parameters: {...}）的顶层键：按行缩进启发——
 *  从 `label: {` 行之后，到缩进回到 label 层级的 `}` 行之间，
 *  收集「缩进比 label 深一层、形如 key: {」的行键名。 */
function topLevelKeys(block, label) {
  const lines = block.split("\n");
  const labelIdx = lines.findIndex((l) => l.includes(`${label}: {`));
  if (labelIdx < 0) return [];
  const baseIndent = lines[labelIdx].match(/^\s*/)[0].length; // 如 parameters 前的 6 空格
  const keys = [];
  for (let i = labelIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*}/.test(line) && line.match(/^\s*/)[0].length <= baseIndent) break; // 对象闭合
    const km = /^(\s{2,})([A-Za-z_$][\w$]*): \{/.exec(line);
    if (km && km[1].length === baseIndent + 2) keys.push(km[2]); // 比 label 深一层 = 顶层键
  }
  return keys;
}

const tools = [];
const registerRe = /tools\.register\(defineTool\(\{([\s\S]*?)\n\s*\}\)\);/g;
let m;
while ((m = registerRe.exec(src))) {
  const block = m[1];
  const nameOf = /name:\s*"([^"]+)"/.exec(block)?.[1] ?? null;
  if (!nameOf) continue;
  const descRaw = /description:\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1] ?? "";
  const description = descRaw.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  const paramKeys = topLevelKeys(block, "parameters");
  const outSchema = /output:\s*\{\s*schema:\s*\{\s*type:\s*"([^"]+)"/.exec(block)?.[1] ?? null;
  tools.push({
    name: nameOf,
    description,
    parameters: paramKeys,
    output: outSchema ? { type: outSchema } : null,
    source: "lib/index.js （tools.register(defineTool)）",
  });
}

const out = {
  plugin: "dsh-session-conductor",
  generatedBy: "tools/detect-registered-tools.mjs（留档用，不调用插件）",
  toolCount: tools.length,
  tools,
};
process.stdout.write(JSON.stringify(out, null, pretty ? 2 : 0) + "\n");