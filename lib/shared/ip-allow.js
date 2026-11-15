// 来源 IP 白名单：跨机会话转发的准入判定（NFS exports 风格）
//
// 【为什么单独成文件】纯逻辑、零依赖、可独立单测。这类判定一旦写错就是「谁都能往你的
// 会话投消息」，比一般业务逻辑更需要断言覆盖；放在路由里会被宿主的可选 peer 依赖拉住，
// 单测 import 不进来。
//
// 【支持的写法】三种，与 NFS 的客户端限制习惯一致：
//   192.168.1.5      精确
//   192.168.1.*      通配（按段匹配，只能整段写 *）
//   192.168.1.0/24   CIDR（只支持 IPv4）
//
// 【默认不开门】白名单为空时只放行本机（127.0.0.1 / ::1）。「没配置」不等于「谁都能用」，
// 这一点与「配置为空即放行」的常见做法相反，是有意为之。

/** 本机回环地址（规范化后的 IPv4 形式）。 */
export const LOOPBACK_IPV4 = '127.0.0.1';

/** IPv4 四段点分形式。 */
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** IPv4 映射的 IPv6 地址：`::ffff:192.168.1.5`。 */
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
/** IPv6 回环。 */
const IPV6_LOOPBACK = '::1';

/**
 * 把 socket 给出的远端地址规范化成 IPv4 字符串。
 *
 * Node 在双栈监听下常给出 `::ffff:192.168.1.5`，不归一会导致白名单里的 IPv4 规则全部匹配不上；
 * 纯 IPv6 地址不在本模块支持范围内，返回 null（由调用方按「拒绝」处理）。
 *
 * @param {unknown} raw `req.socket.remoteAddress` 之类的原始值
 * @returns {string|null} 规范化后的 IPv4，或 null（无法识别/不支持）
 */
export function normalizeRemoteAddress(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const mapped = IPV4_MAPPED_PATTERN.exec(trimmed);
  if (mapped) return mapped[1];
  if (trimmed === IPV6_LOOPBACK) return LOOPBACK_IPV4;
  if (IPV4_PATTERN.test(trimmed)) return trimmed;
  return null;
}

/**
 * IPv4 转 32 位无符号整数（用于 CIDR 掩码比较）。
 * @param {string} ip 已校验的 IPv4 字符串
 * @returns {number}
 */
function ipv4ToUint32(ip) {
  let value = 0;
  for (const part of ip.split('.')) value = value * 256 + Number(part);
  return value >>> 0;
}

/**
 * 单条规则是否匹配该 IP。
 * @param {string} ip 已规范化的 IPv4
 * @param {string} rule 精确 / 通配 / CIDR
 * @returns {boolean}
 */
export function matchesRule(ip, rule) {
  if (typeof rule !== 'string') return false;
  const trimmed = rule.trim();
  if (trimmed === '') return false;

  // CIDR
  if (trimmed.includes('/')) {
    const [base, bitsText] = trimmed.split('/');
    // 漏写位数（如 `10.0.0.0/`）时 Number('') === 0，会被当成 /0「匹配全部」——
    // 一个笔误就把白名单变成全放行，必须显式拦住空位数。
    if (typeof bitsText !== 'string' || bitsText.trim() === '') return false;
    const bits = Number(bitsText);
    if (!IPV4_PATTERN.test(base ?? '') || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    // 左移 32 位在 JS 里会变成 0，需单独处理 /0
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4ToUint32(ip) & mask) === (ipv4ToUint32(base) & mask);
  }

  // 通配：只允许整段写 *，避免出现 192.168.1*.5 这种含糊规则
  if (trimmed.includes('*')) {
    const ruleParts = trimmed.split('.');
    const ipParts = ip.split('.');
    if (ruleParts.length !== 4) return false;
    return ruleParts.every((part, index) => part === '*' || part === ipParts[index]);
  }

  // 精确
  return trimmed === ip;
}

/**
 * 该来源是否被允许。
 *
 * @param {string|null} remoteIp 已规范化的 IPv4（通常来自 normalizeRemoteAddress）
 * @param {string[]} rules 白名单规则
 * @returns {boolean}
 */
export function ipAllowed(remoteIp, rules) {
  if (remoteIp === null || remoteIp === undefined || remoteIp === '') return false;
  // 本机直连永远放行：否则本机 curl 自测、同机多实例之间都没法用
  if (remoteIp === LOOPBACK_IPV4) return true;
  const list = Array.isArray(rules) ? rules : [];
  if (list.length === 0) return false;
  return list.some((rule) => matchesRule(remoteIp, rule));
}

/** 中继对端缺省端口（DSH 默认 HTTP 端口）。 */
export const DEFAULT_RELAY_PORT = '30800';

/**
 * 把对端地址规范化成 `http(s)://host:port`（不含路径）。
 *
 * 允许只写主机名（端口用默认），也允许误粘贴带路径的完整 URL —— 路径一律丢弃，
 * 避免拼出 `http://a:30800/api/xxx/api/session-conductor/...` 这种怪地址。
 *
 * @param {unknown} target 形如 `10.0.0.5:30800` / `10.0.0.5` / `http://10.0.0.5:30800/xxx`
 * @returns {string|null} 规范化后的 base URL，非法返回 null
 */
export function normalizeTarget(target) {
  if (typeof target !== 'string') return null;
  const trimmed = target.trim();
  if (trimmed === '') return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  const port = parsed.port === '' ? DEFAULT_RELAY_PORT : parsed.port;
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}
