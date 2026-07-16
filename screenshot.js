const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const OUTPUT_PATH = path.resolve(process.cwd(), 'screenshot.png');
const VIEWPORT = { width: 1440, height: 900 };
const SCROLL_WAIT_MS = 800;
const REQUIRED_STABLE_CHECKS = 5;
const MAX_SCROLLS = 300;

function readUrl() {
  const input = process.argv[2];

  if (!input) {
    throw new Error('請提供網址，例如：node screenshot.js "https://example.com"');
  }

  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('只支援 http:// 或 https:// 網址。');
  }

  return url.href;
}

async function pageMetrics(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement;
    const body = document.body;
    const height = Math.max(
      root.scrollHeight,
      root.offsetHeight,
      root.clientHeight,
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      body?.clientHeight || 0,
    );

    return {
      height,
      scrollTop: root.scrollTop,
      viewportHeight: window.innerHeight,
    };
  });
}

async function scrollToTrueBottom(page) {
  let stableChecks = 0;

  for (let attempt = 1; attempt <= MAX_SCROLLS; attempt += 1) {
    const before = await pageMetrics(page);

    await page.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
      root.scrollTo({
        top: Math.min(root.scrollTop + step, root.scrollHeight),
        behavior: 'instant',
      });
    });

    await page.waitForTimeout(SCROLL_WAIT_MS);

    const after = await pageMetrics(page);
    const heightIncreased = after.height > before.height;
    const atBottom = after.scrollTop + after.viewportHeight >= after.height - 2;

    if (heightIncreased) {
      stableChecks = 0;
    } else if (atBottom) {
      stableChecks += 1;
    } else {
      stableChecks = 0;
    }

    if (attempt === 1 || attempt % 10 === 0 || heightIncreased || stableChecks > 0) {
      console.log(
        `捲動 ${attempt}: 頁高 ${after.height}px，底部穩定 ${stableChecks}/${REQUIRED_STABLE_CHECKS}`,
      );
    }

    if (stableChecks >= REQUIRED_STABLE_CHECKS) {
      return after;
    }
  }

  const last = await pageMetrics(page);
  throw new Error(
    `捲動 ${MAX_SCROLLS} 次後頁面仍未穩定（目前頁高 ${last.height}px）。` +
      '這可能是真正無限的內容流，已停止以避免永不結束。',
  );
}

async function waitForVisibleAssets(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    const pendingImages = Array.from(document.images)
      .filter((image) => !image.complete)
      .map(
        (image) =>
          new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
          }),
      );

    await Promise.race([
      Promise.all(pendingImages),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  });
}

async function saveCurrentPage(page, label) {
  try {
    await page.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      root.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: OUTPUT_PATH, fullPage: true });
    console.error(`${label}已保存當下頁面：${OUTPUT_PATH}`);
  } catch (screenshotError) {
    console.error(`${label}無法保存當下頁面：${screenshotError.message}`);
  }
}

async function main() {
  fs.rmSync(OUTPUT_PATH, { force: true });

  let browser;
  let page;

  try {
    const url = readUrl();
    const installedChromium = chromium.executablePath();
    const launchOptions = { headless: true };

    // Some Playwright installations include the full Chromium build but not
    // the separate headless-shell binary. Prefer the installed full browser
    // when it is available; it is still controlled entirely through Playwright.
    if (fs.existsSync(installedChromium)) {
      launchOptions.executablePath = installedChromium;
    }

    browser = await chromium.launch(launchOptions);
    page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    console.log(`載入：${url}`);
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    if (response && response.status() >= 400) {
      throw new Error(`伺服器回傳 HTTP ${response.status()} ${response.statusText()}`);
    }

    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    console.log(`頁面標題：${await page.title()}`);
    console.log(`最終網址：${page.url()}`);

    const bottom = await scrollToTrueBottom(page);
    console.log(`已抵達真正底部，最終頁高 ${bottom.height}px。`);

    await waitForVisibleAssets(page);
    await page.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      root.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: OUTPUT_PATH, fullPage: true });

    console.log(`截圖完成：${OUTPUT_PATH}`);
  } catch (error) {
    console.error(`執行失敗：${error.stack || error.message}`);
    if (page && !page.isClosed()) {
      await saveCurrentPage(page, '錯誤截圖');
    }
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

main();
