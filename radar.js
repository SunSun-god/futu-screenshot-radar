const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FUTU_URL =
  'https://news.futunn.com/hk/main/live?chain_id=pQ0K_pS2tp94iH.1l5esi8&global_content=%7B%22promote_id%22%3A13766,%22sub_promote_id%22%3A1,%22f%22%3A%22nn%2Fhk%22%7D&lang=zh-hk';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const PROCESSED_PATH = path.join(DATA_DIR, 'processed.json');
const VIEWPORT = { width: 1440, height: 900 };
const SCROLL_WAIT_MS = 800;
const REQUIRED_STABLE_CHECKS = 5;
const MAX_SCROLLS = 300;
const MAX_HISTORY_ITEMS = 2000;
const MAX_FEED_ITEMS = 500;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function candidateId(item) {
  return `futu-${crypto
    .createHash('sha256')
    .update(`${item.time}\n${item.title}\n${item.body}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readProcessedState() {
  const parsed = readJson(PROCESSED_PATH, null);
  if (!parsed || parsed.schema_version !== 1 || !Array.isArray(parsed.items)) {
    return { schema_version: 1, items: [] };
  }

  return {
    schema_version: 1,
    items: parsed.items
      .filter(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          typeof item.time === 'string' &&
          typeof item.title === 'string' &&
          typeof item.body === 'string' &&
          typeof item.first_seen_at === 'string' &&
          typeof item.last_seen_at === 'string',
      )
      .slice(0, MAX_HISTORY_ITEMS),
  };
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

    if (heightIncreased) stableChecks = 0;
    else if (atBottom) stableChecks += 1;
    else stableChecks = 0;

    if (attempt === 1 || attempt % 10 === 0 || heightIncreased || stableChecks > 0) {
      console.log(
        `scroll ${attempt}: height=${after.height}px stable=${stableChecks}/${REQUIRED_STABLE_CHECKS}`,
      );
    }

    if (stableChecks >= REQUIRED_STABLE_CHECKS) return after;
  }

  const last = await pageMetrics(page);
  throw new Error(
    `Page did not reach a stable bottom after ${MAX_SCROLLS} scrolls (height ${last.height}px).`,
  );
}

async function extractOrangeNodes(page) {
  return page.evaluate(() => {
    function rgb(value) {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      return match ? match.slice(1, 4).map(Number) : null;
    }

    function isOrange(value) {
      const color = rgb(value);
      if (!color) return false;
      const [red, green, blue] = color;
      return red >= 190 && green >= 55 && green <= 165 && blue <= 95 && red - green >= 55;
    }

    return [...document.querySelectorAll('body *')]
      .map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
        const hasOrangeChild = [...element.children].some((child) => {
          const childText = (child.innerText || '').trim();
          return childText && isOrange(getComputedStyle(child).color);
        });

        return {
          text,
          color: style.color,
          fontSize: Number.parseFloat(style.fontSize) || 0,
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none',
          hasOrangeChild,
        };
      })
      .filter(
        (item) =>
          item.visible &&
          item.text.length >= 2 &&
          !item.hasOrangeChild &&
          isOrange(item.color),
      )
      .sort((left, right) => left.y - right.y || left.x - right.x);
  });
}

function structureAlerts(nodes) {
  const uniqueNodes = [];
  const nodeKeys = new Set();

  for (const rawNode of nodes) {
    const text = cleanText(rawNode.text);
    if (!text) continue;
    const key = `${rawNode.y}|${rawNode.x}|${text}`;
    if (nodeKeys.has(key)) continue;
    nodeKeys.add(key);
    uniqueNodes.push({ ...rawNode, text });
  }

  const timeNodes = uniqueNodes.filter((node) => TIME_PATTERN.test(node.text));
  const alerts = [];

  for (let index = 0; index < timeNodes.length; index += 1) {
    const timeNode = timeNodes[index];
    const nextTimeY = timeNodes[index + 1]?.y ?? Number.POSITIVE_INFINITY;
    const contentNodes = uniqueNodes
      .filter(
        (node) =>
          node !== timeNode &&
          node.y >= timeNode.y - 2 &&
          node.y < nextTimeY - 2 &&
          node.x > timeNode.x + 40 &&
          node.text !== '加載更多' &&
          !TIME_PATTERN.test(node.text),
      )
      .sort((left, right) => left.y - right.y || left.x - right.x);

    const content = [];
    const contentKeys = new Set();
    for (const node of contentNodes) {
      if (contentKeys.has(node.text)) continue;
      contentKeys.add(node.text);
      content.push(node);
    }

    if (!content.length) continue;

    const titleNode = content.find((node) => node.fontWeight >= 600) ?? content[0];
    const titleIndex = content.indexOf(titleNode);
    const title = cleanText(titleNode.text);
    const body = content
      .filter((_, nodeIndex) => nodeIndex !== titleIndex)
      .map((node) => cleanText(node.text))
      .filter(Boolean)
      .join('\n');

    if (!title) continue;
    alerts.push({ time: timeNode.text, title, body });
  }

  const uniqueAlerts = [];
  const alertIds = new Set();
  for (const alert of alerts) {
    const id = candidateId(alert);
    if (alertIds.has(id)) continue;
    alertIds.add(id);
    uniqueAlerts.push({ id, ...alert });
  }

  return uniqueAlerts;
}

function mergeProcessed(previous, currentItems, capturedAt) {
  const records = new Map(previous.items.map((item) => [item.id, item]));
  const newItems = [];

  for (const item of currentItems) {
    const existing = records.get(item.id);
    if (existing) {
      records.set(item.id, { ...existing, last_seen_at: capturedAt });
    } else {
      const record = {
        ...item,
        first_seen_at: capturedAt,
        last_seen_at: capturedAt,
      };
      records.set(item.id, record);
      newItems.push(record);
    }
  }

  const items = [...records.values()]
    .sort((left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at))
    .slice(0, MAX_HISTORY_ITEMS);

  return { items, newItems };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { chromium } = require('playwright');
  const capturedAt = new Date().toISOString();
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const response = await page.goto(FUTU_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    if (response && response.status() >= 400) {
      throw new Error(`Futu returned HTTP ${response.status()} ${response.statusText()}`);
    }

    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    const bottom = await scrollToTrueBottom(page);
    console.log(`stable bottom reached: ${bottom.height}px`);

    const nodes = await extractOrangeNodes(page);
    const extractedItems = structureAlerts(nodes);
    const previous = readProcessedState();
    const merged = mergeProcessed(previous, extractedItems, capturedAt);

    const processed = {
      schema_version: 1,
      source_page: FUTU_URL,
      updated_at: capturedAt,
      items: merged.items,
    };
    const latest = {
      schema_version: 1,
      generated_at: capturedAt,
      source_page: FUTU_URL,
      status: 'ok',
      extracted_count: extractedItems.length,
      new_count: merged.newItems.length,
      items: merged.items.slice(0, MAX_FEED_ITEMS),
      new_items: merged.newItems,
    };

    fs.writeFileSync(PROCESSED_PATH, `${JSON.stringify(processed, null, 2)}\n`);
    fs.writeFileSync(LATEST_PATH, `${JSON.stringify(latest, null, 2)}\n`);
    console.log(
      `structured ${extractedItems.length} orange alerts; ${merged.newItems.length} were new`,
    );
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { candidateId, cleanText, mergeProcessed, structureAlerts };
