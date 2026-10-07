/** HTTP 小工具：响应发送与请求体解析（供路由 handler 共用）。 */

// ---------- 自动重命名参数 ----------
// （自动重命名的门槛与限流常量随分析引擎迁入 features/rename/analysis.js）

// ---------- 自动续跑参数（可用 patch config 覆盖） ----------
// （标题状态后缀常量随标题域迁入 features/rename/title.js；
//   AUTO_CONTINUE_HUMAN_ABORT_KINDS 随中断判定迁入 sessions/interruption.js）
// （续跑防抖与首扫延迟常量随扫描迁入 features/continue/scan.js）

// ---------- 基础工具 ----------

export function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 读取 JSON 请求体（POST 必须带 Content-Type: application/json）。 */
export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}
