#!/usr/bin/env node
// 生成 __SC_FALLBACK__ 内嵌行（i18n.js 分片 L14）——fallback 是导航/设置文案兜底，
// 从 lib/i18n/{zh,en}.json 生成：sessionConductorSettings 全量 + 其他 NS 的关键键（title/nav/label/desc/tab/badge）。
// 用法：node tools/gen-fallback.mjs（幂等，仅重写 foundation/i18n.js 的 fallback 行）
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const i18nFile = join(root, "lib", "i18n", "zh.json");
const i18nEnFile = join(root, "lib", "i18n", "en.json");
const target = join(root, "lib", "client-parts", "foundation", "i18n.js");

const zh = JSON.parse(readFileSync(i18nFile, "utf8"));
const en = JSON.parse(readFileSync(i18nEnFile, "utf8"));

function pick(ns, full) {
  const d = zh[ns] || {};
  const e = en[ns] || {};
  if (full) {
    const out = {};
    for (const k of Object.keys(d)) out[k] = d[k];
    return out;
  }
  const out = {};
  for (const k of Object.keys(d)) {
    if (k.includes("title") || k.includes("nav") || k.includes("label") || k.includes("desc") || k.startsWith("tab.") || k.startsWith("badge.")) {
      out[k] = d[k];
    }
  }
  return out;
}

const fbZh = {
  sessionConductor: pick("sessionConductor", false),
  sessionGroup: pick("sessionGroup", false),
  sessionConductorCompaction: pick("sessionConductorCompaction", false),
  sessionConductorSettings: pick("sessionConductorSettings", true),
};
const fbEn = {};
for (const ns of Object.keys(fbZh)) {
  fbEn[ns] = {};
  for (const k of Object.keys(fbZh[ns])) fbEn[ns][k] = (en[ns] && en[ns][k]) ?? fbZh[ns][k];
}

const line = `window.__SC_FALLBACK__ = { zh: ${JSON.stringify(fbZh)}, en: ${JSON.stringify(fbEn)} };`;

const src = readFileSync(target, "utf8");
const m = src.match(/window\.__SC_FALLBACK__ = \{ zh: .*?, en: .*? \};/s);
if (!m) {
  console.error("❌ 未找到 fallback 行");
  process.exit(1);
}
const next = src.slice(0, m.index) + line + src.slice(m.index + m[0].length);
if (next !== src) writeFileSync(target, next);
console.log(`✅ fallback 已更新（${line.length} 字节，zh settings ${Object.keys(fbZh.sessionConductorSettings).length} 键）`);
