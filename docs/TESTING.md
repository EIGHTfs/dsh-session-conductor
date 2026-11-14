# 实测流程：隔离实例与部署副本

> 本文件记录「新功能怎么验证才算验过」。单测只能覆盖纯逻辑，涉及宿主服务（路由注册、索引落盘、
> 真实的会话数据）必须到隔离实例里跑一遍。

## 一、为什么用隔离实例

主实例装着用户正在用的会话，不能为了验证一个路由去重启它。`useful-tools` 提供的测试环境是
独立 DSH_HOME + 独立端口（3083），装坏了只影响它自己。

## 二、安装三步（缺第二步会加载失败）

```bash
# ① 同步进测试环境并注册（dshHome 指向测试环境根，不是主实例）
sync_plugin({ dshHome: "<测试环境>", pluginName: "dsh-session-conductor", write: true, register: true })

# ② 建 node_modules 解析入口（相对符号链接，与 pnpm file: 依赖的产物一致）
ln -s ../local-plugins/dsh-session-conductor <测试环境>/profiles/web/node_modules/dsh-session-conductor

# ③ 启动
test_env({ action: "start" })      # 端口 3083
```

**为什么需要第 ② 步**：`sync_plugin` 只写 `local-plugins/` 与 profile 的 `dependencies`
（`file:local-plugins/...`），**不生成 `node_modules` 下的解析入口**。而宿主按 bundle 从
`node_modules` 解析，缺链接直接：

```
dsh: skipping profile bundle "dsh-session-conductor":
cannot resolve profile bundle from the dsh installation or .../profiles/web
```

插件进程根本没起，后面所有接口测试都会得到「路由不存在」的假结论。

`sync_plugin` 的 `deps` 检查会报缺 `@deepseek-ai/dsh-llm` 等四个 peer —— 那是**预期的**：
这些包由宿主本体提供，测试环境的 profile node_modules 里本来就没有，宿主启动时能解析到。
不要为此去装包。

## 三、调用接口（需要 token）

```bash
TOKEN=$(grep -aoE "token=[A-Za-z0-9_-]{8,}" <测试环境>/dsh-env.log | tail -1 | cut -d= -f2)
curl -s "http://127.0.0.1:3083/api/session-conductor/<路由>" -H "Cookie: dsh_session=$TOKEN"
```

用完 `test_env({ action: "stop" })` 释放端口。

## 四、涉及持久化的功能必须验「重启后还在」

索引类数据（未读、缓存、回收站）存在 `index.json`，而 `normalizeStore` 是**白名单重建**：
新增 section 若只在 `getSection` 里动态创建、没同时登记进 `emptyStore()` 与 `normalizeStore()`，
就会出现「写进去 → 重启 → 静默消失」，接口测试完全看不出来。

验证方式：写入 → `test_env stop` → `test_env start` → 再读，比对是否一致。

## 五、主实例部署副本：两个不同的坑

主实例（`profiles/web`）是 `local-plugins/` 与 `node_modules/` 两份，且**布局是混合的**：
多数文件互为硬链接（同 inode，改一边等于改两边），但存在**独立副本**（同步不会跟随）。

同步之后必须同时查两件事：

```bash
cd <local-plugins>/dsh-session-conductor
find lib package.json -type f | while read f; do
  if [ ! -f "<node_modules>/dsh-session-conductor/$f" ]; then echo "MISSING: $f"
  elif ! cmp -s "$f" "<node_modules>/dsh-session-conductor/$f"; then echo "DIFF: $f"; fi
done
```

| 现象 | 原因 | 处理 |
|---|---|---|
| `MISSING` | 新文件只写进了 `local-plugins` | `ln <源> <目标>` 补硬链接 |
| `DIFF` | 该文件在 `node_modules` 侧是独立副本，同步不跟随 | 同上（先备份旧的） |

两种都会导致**插件整体 import 失败**（`ERR_MODULE_NOT_FOUND` 或加载到旧代码），
且宿主日志只有一行 `failed to import`，容易漏看。

## 六、前端改动的三级验证

| 级别 | 手段 | 能发现 | 不能发现 |
|---|---|---|---|
| 1 | 单测 + `node build.cjs --check` | 逻辑错、产物与分片不同步 | 渲染问题 |
| 2 | `preview`（真实 client.js 垫片渲染，默认接真实后端） | 结构错误、字段对不上 | 宿主真实环境差异 |
| 3 | 测试环境 + 浏览器实测 | 真实渲染、真实事件链路、主题/语言包差异 | — |

UI 改动至少走第 2 级；涉及布局、交互、主题的走到第 3 级。

## 七、收尾

```bash
test_env({ action: "stop" })    # 必做，别让 3083 常驻
node test/run-all.mjs           # 全量回归
code_audit({ scope: "diff" })   # 必须 0 拦截
```
