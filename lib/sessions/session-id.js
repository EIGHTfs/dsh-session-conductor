// dsh-session-conductor — 会话 id 判据（零依赖叶子模块）
//
// 【为什么单独一个文件】这条判据是「会话列表项必须有 id」这条不变量的**唯一定义处**，
// 上游净化（归档集合）、补全守卫、回退校验（persistence.list）、emit 兜底四处共用。
// 放在 list.js 里会因依赖链（core/domain.js → 宿主包 @deepseek-ai/dsh-storage-domain）
// 而**无法被单测直接导入**；抽成零依赖叶子模块后，单测可功能级覆盖它本身，
// 再用结构断言钉住「list.js 的四处都走它」。
//
// 【背景】宿主持久化里出现过脏值：归档 id 集合混入 undefined 时，补全循环会造出
// `{ id: undefined }` 的 meta，最终产出一条没有 id 的列表项，读该会话事件时抛
// "Cannot read properties of undefined (reading 'length')"。

/**
 * 该值能否作为会话 id：**非空字符串**。
 *
 * 注意只认字符串 —— 数字/对象/空串/null/undefined 一律不算（列表项 id 会被前端用作
 * DOM key 与路由参数，也会被工具拿去查会话，任何非字符串都会在别处炸得更隐蔽）。
 *
 * @param {unknown} value 待判定的值
 * @returns {boolean} 是否可作会话 id
 */
export function isValidSessionId(value) {
  return typeof value === "string" && value !== "";
}
