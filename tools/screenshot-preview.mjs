// dsh-session-conductor — 预览 html 自动截图（playwright chromium，mediascape 同款环境）
// 产物：assets/screenshots/settings.png、panel.png（README 配图 + screenshots.json 声明）
// 运行：node tools/screenshot-preview.mjs（CHROME/LIBS/FONTS/OUT 均可 env 覆盖，不硬编码）
import { chromium } from 'file:///volume1/VirtualDSM/DeepSeekHarness/pwviewer/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MS_CHROME || '/volume1/@appdata/DeepSeekHarness-NAS/0.1.6-alpha.1/工作区/.pwviewer/browsers/chromium-1243/chrome-linux64/chrome';
const MS_LIBS = process.env.MS_CHROMELIBS || '/volume1/VirtualDSM/DeepSeekHarness/pwviewer-libs';
const MS_FONTS = process.env.MS_FONTCONF || '/volume1/VirtualDSM/DeepSeekHarness/fonts/fonts.conf';
const OUT = process.env.MS_OUT_DIR || join(ROOT, 'assets', 'screenshots');

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: MS_LIBS, FONTCONFIG_FILE: MS_FONTS },
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 150)));

try {
  // ① 设置页（模板注入）预览
  await page.goto('file://' + join(ROOT, 'assets', 'preview-settings.html'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('text=模板注入', { timeout: 20000 }).catch(() => console.log('  settings: 模板注入 未在 20s 内出现（仍截图）'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'settings.png'), fullPage: true });
  console.log('✓ settings.png');

  // ② 会话管理面板预览
  await page.goto('file://' + join(ROOT, 'assets', 'preview-panel.html'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('text=全部会话', { timeout: 20000 }).catch(() => console.log('  panel: 全部会话 未在 20s 内出现（仍截图）'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, 'panel.png'), fullPage: true });
  console.log('✓ panel.png');
} finally {
  await browser.close();
}
console.log('截图完成 ->', OUT);