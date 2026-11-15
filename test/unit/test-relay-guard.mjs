// 跨机中继的准入判定：来源 IP 规范化 / 白名单匹配 / 目标地址规范化
//
// 【守的是什么】白名单判错 = 同网段任何人都能往你的会话里投消息；判太严 = 自己也连不上。
// 两类错都只能靠断言发现，所以这里把边界写全：精确 / 通配 / CIDR / IPv6 映射 / 空列表。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOOPBACK_IPV4,
  ipAllowed,
  matchesRule,
  normalizeRemoteAddress,
  normalizeTarget,
} from '../../lib/shared/ip-allow.js';


test('normalizeRemoteAddress：IPv4 原样返回，IPv6 映射与回环归一到 IPv4', () => {
  assert.equal(normalizeRemoteAddress('192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeRemoteAddress('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeRemoteAddress('::1'), '127.0.0.1');
  assert.equal(normalizeRemoteAddress(' 10.0.0.7 '), '10.0.0.7');
});

test('normalizeRemoteAddress：非法/纯 IPv6/非字符串一律 null', () => {
  assert.equal(normalizeRemoteAddress(''), null);
  assert.equal(normalizeRemoteAddress('fe80::1'), null, '纯 IPv6 不在支持范围');
  assert.equal(normalizeRemoteAddress(null), null);
  assert.equal(normalizeRemoteAddress(undefined), null);
  assert.equal(normalizeRemoteAddress(123), null);
});

test('matchesRule：精确匹配', () => {
  assert.equal(matchesRule('192.168.1.5', '192.168.1.5'), true);
  assert.equal(matchesRule('192.168.1.6', '192.168.1.5'), false);
});

test('matchesRule：整段通配', () => {
  assert.equal(matchesRule('192.168.1.5', '192.168.1.*'), true);
  assert.equal(matchesRule('192.168.2.5', '192.168.1.*'), false);
  assert.equal(matchesRule('10.1.2.3', '10.*.2.*'), true);
});

test('matchesRule：通配只能整段写（段内混写视为非法规则）', () => {
  assert.equal(matchesRule('192.168.1.5', '192.168.1*.5'), false);
  assert.equal(matchesRule('192.168.1.5', '192.168.*'), false, '段数不足视为非法');
});

test('matchesRule：CIDR 掩码比较', () => {
  assert.equal(matchesRule('192.168.1.5', '192.168.1.0/24'), true);
  assert.equal(matchesRule('192.168.2.5', '192.168.1.0/24'), false);
  assert.equal(matchesRule('10.0.0.1', '0.0.0.0/0'), true, '/0 表示全部');
  assert.equal(matchesRule('10.0.0.1', '10.0.0.1/32'), true);
  assert.equal(matchesRule('10.0.0.2', '10.0.0.1/32'), false);
});

test('matchesRule：非法 CIDR 一律不匹配（不抛）', () => {
  assert.equal(matchesRule('10.0.0.1', '10.0.0.0/33'), false);
  assert.equal(matchesRule('10.0.0.1', '10.0.0.0/abc'), false);
  assert.equal(matchesRule('10.0.0.1', '10.0.0.0/'), false);
});

test('ipAllowed：空列表只放行本机（默认不对局域网开门）', () => {
  assert.equal(ipAllowed(LOOPBACK_IPV4, []), true, '本机永远放行');
  assert.equal(ipAllowed('192.168.1.5', []), false);
  assert.equal(ipAllowed('192.168.1.5', null), false);
});

test('ipAllowed：本机即使不在白名单里也放行（同机多实例、本机 curl 自测）', () => {
  assert.equal(ipAllowed('127.0.0.1', ['10.0.0.1']), true);
});

test('ipAllowed：命中任一规则即放行，非法来源拒绝', () => {
  const rules = ['10.0.0.1', '192.168.1.*', '172.16.0.0/16'];
  assert.equal(ipAllowed('10.0.0.1', rules), true);
  assert.equal(ipAllowed('192.168.1.77', rules), true);
  assert.equal(ipAllowed('172.16.5.4', rules), true);
  assert.equal(ipAllowed('8.8.8.8', rules), false);
  assert.equal(ipAllowed(null, rules), false, '无法识别的来源按拒绝处理');
});

test('normalizeTarget：补协议、补默认端口、丢弃多余路径', () => {
  assert.equal(normalizeTarget('10.0.0.5:30800'), 'http://10.0.0.5:30800');
  assert.equal(normalizeTarget('http://10.0.0.5:30800'), 'http://10.0.0.5:30800');
  assert.equal(normalizeTarget('10.0.0.5'), 'http://10.0.0.5:30800', '缺端口用默认');
  assert.equal(normalizeTarget('http://10.0.0.5:30800/api/session-conductor/x'), 'http://10.0.0.5:30800', '路径被丢弃');
  assert.equal(normalizeTarget('https://host.lan:9000'), 'https://host.lan:9000');
});

test('normalizeTarget：空/非法返回 null', () => {
  assert.equal(normalizeTarget(''), null);
  assert.equal(normalizeTarget('   '), null);
  assert.equal(normalizeTarget(null), null);
  assert.equal(normalizeTarget('http://'), null);
});
