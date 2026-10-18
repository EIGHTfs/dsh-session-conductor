// 分阶段计时 —— 只做观测，不改变任何行为。
//
// 【为什么需要】「切模型要等很久」这类问题，光看总耗时没法定位：一次切换里串了
// 写意图 / 定位成员 / 等 idle / 写会话日志（整份解码+重编码）/ 官方 @Remote 调用 好几段。
// 每段各自打点，末尾输出一行「写意图 12ms ｜ 等空闲 60000ms ｜ …」，
// 一眼能看出慢在哪一段。
//
// 【为什么不设超时】超时代码会改变行为、还会掩盖真实的慢；这里只测量、只记录。

/**
 * 创建分阶段计时器。
 * @returns {{mark:(name:string)=>number, summary:()=>string, total:()=>number, stages:()=>Array<{name:string,ms:number}>}}
 */
export function createStageTimer() {
  const marks = [];
  let lastAt = Date.now();
  return {
    /** 记录一个阶段（从上次打点到现在）。 */
    mark(name) {
      const now = Date.now();
      marks.push({ name, ms: now - lastAt });
      lastAt = now;
      return now;
    },
    /** 一行汇总，如「写意图 12ms ｜ 等空闲 60000ms」。 */
    summary() {
      return marks.map((m) => `${m.name} ${m.ms}ms`).join(" ｜ ");
    },
    /** 各阶段耗时合计（不含未被标记覆盖的空隙）。 */
    total() {
      return marks.reduce((sum, m) => sum + m.ms, 0);
    },
    stages() {
      return marks.slice();
    },
  };
}
