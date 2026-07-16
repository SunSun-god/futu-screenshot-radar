const fs = require('node:fs');
const { chromium } = require('playwright');

const URL = 'https://news.futunn.com/hk/main/live?chain_id=pQ0K_pS2tp94iH.1l5esi8&global_content=%7B%22promote_id%22%3A13766,%22sub_promote_id%22%3A1,%22f%22%3A%22nn%2Fhk%22%7D&lang=zh-hk';

function parseRgb(value) {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const candidates = await page.evaluate(() => {
      function rgb(value) {
        const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        return m ? m.slice(1, 4).map(Number) : null;
      }
      function isOrange(value) {
        const c = rgb(value);
        if (!c) return false;
        const [r, g, b] = c;
        return r >= 190 && g >= 55 && g <= 165 && b <= 95 && r - g >= 55;
      }

      return [...document.querySelectorAll('body *')]
        .map((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const hasOrangeChild = [...el.children].some((child) => {
            const childText = (child.innerText || '').trim();
            return childText && isOrange(getComputedStyle(child).color);
          });
          return {
            text,
            color: style.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            hasOrangeChild,
          };
        })
        .filter((item) => item.visible && item.text.length >= 2 && !item.hasOrangeChild && isOrange(item.color))
        .sort((a, b) => a.y - b.y || a.x - b.x);
    });

    const unique = [];
    const seen = new Set();
    for (const item of candidates) {
      const key = `${item.y}|${item.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }

    const likelyTitles = unique.filter((item) => item.text.length <= 100 && Number.parseInt(item.fontSize, 10) >= 14);
    const output = {
      capturedAt: new Date().toISOString(),
      url: URL,
      latestLikelyTitle: likelyTitles[0]?.text || null,
      candidates: unique,
    };

    fs.writeFileSync('orange-candidates.json', JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
