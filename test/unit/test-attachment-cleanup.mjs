// 缺失附件引用清理：路径解析 / 识别 / 替换 的单元测试
//
// 【守的是什么】这些函数直接改会话数据，判错会毁会话：
//   · 路径解析必须严格（不能被 `../` 之类注入到别的目录）
//   · 只替换「引用了不存在附件」的块，存在的附件一个都不许动
//   · 替换是原地换文本，不得改动块的数量、顺序与其它字段

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachmentObjectPath,
  findMissingAttachments,
  missingAttachmentsInContent,
  placeholderForAttachment,
  stripMissingAttachments,
} from '../../lib/sessions/attachment-cleanup.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** 建一个临时 DSH_HOME，按需创建附件实体。 */
function makeHomeWith(existingHashes) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-'));
  for (const hash of existingHashes) {
    const dir = join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, hash), 'stub');
  }
  return home;
}

test('attachmentObjectPath：合法 sha256 解析到 objects/<前2位>/<hash>', () => {
  const path = attachmentObjectPath('/home/.dsh', `sha256:${HASH_A}`);
  assert.equal(path, join('/home/.dsh', 'attachments', 'v1', 'objects', 'aa', HASH_A));
});

test('attachmentObjectPath：非法/未知格式一律返回 null（不允许拼出越界路径）', () => {
  assert.equal(attachmentObjectPath('/h', 'sha256:../../etc/passwd'), null);
  assert.equal(attachmentObjectPath('/h', 'md5:' + HASH_A), null);
  assert.equal(attachmentObjectPath('/h', ''), null);
  assert.equal(attachmentObjectPath('/h', undefined), null);
});

test('missingAttachmentsInContent：只把「文件不存在」的块算缺失', () => {
  const home = makeHomeWith([HASH_A]);
  try {
    const content = [
      { type: 'text', text: '普通文本不受影响' },
      { type: 'image', attachment: { attachmentId: `sha256:${HASH_A}` } }, // 存在
      { type: 'image', attachment: { attachmentId: `sha256:${HASH_B}` } }, // 缺失
    ];
    const hits = missingAttachmentsInContent(content, home);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].index, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('findMissingAttachments：data.content 与 data.inserted[].content 两个面都覆盖', () => {
  const home = makeHomeWith([]);
  try {
    const events = [
      { seq: 1, type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${HASH_A}` } }] } },
      { seq: 2, type: 'agent/inbox/spliced', data: { inserted: [{ content: [{ type: 'image', attachment: { attachmentId: `sha256:${HASH_B}` } }] }] } },
      { seq: 3, type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi' }] } },
    ];
    const hits = findMissingAttachments(events, { home });
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.seq), [1, 2]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('stripMissingAttachments：原位替换成文本占位，块数与顺序不变，且不改入参', () => {
  const home = makeHomeWith([]);
  try {
    const events = [{
      seq: 7,
      type: 'user/message',
      data: { content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', attachment: { attachmentId: `sha256:${HASH_A}`, name: 'shot.jpg', mediaType: 'image/jpeg', width: 100, height: 50 } },
      ] },
    }];
    const snapshot = JSON.stringify(events);
    const { events: cleaned, stripped } = stripMissingAttachments(events, { home });

    assert.equal(stripped.length, 1, '应报告 1 处替换');
    assert.equal(JSON.stringify(events), snapshot, '入参不得被修改');

    const content = cleaned[0].data.content;
    assert.equal(content.length, 2, '块数不变');
    assert.equal(content[0].text, '看这张图', '非附件块原样保留');
    assert.equal(content[1].type, 'text');
    assert.match(content[1].text, /附件已缺失/);
    assert.match(content[1].text, /shot\.jpg/);
    assert.match(content[1].text, /100×50/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('stripMissingAttachments：附件都在时原样返回，不做任何替换', () => {
  const home = makeHomeWith([HASH_A]);
  try {
    const events = [{ seq: 1, type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${HASH_A}` } }] } }];
    const { stripped } = stripMissingAttachments(events, { home });
    assert.equal(stripped.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('placeholderForAttachment：缺 name/mediaType 时也有可读输出', () => {
  const text = placeholderForAttachment({ attachmentId: `sha256:${HASH_A}` }).text;
  assert.match(text, /未命名附件/);
  assert.match(text, /类型未知/);
});
