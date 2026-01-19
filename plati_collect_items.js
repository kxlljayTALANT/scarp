#!/usr/bin/env node
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const options = {
  startPage: 1,
  maxPages: 200,
  delayMs: 200,
  out: 'plati_items_raw.json',
  lang: 'ru-RU',
  curr: 'RUR',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--start-page') options.startPage = Number(args[++i]);
  else if (arg === '--max-pages') options.maxPages = Number(args[++i]);
  else if (arg === '--delay-ms') options.delayMs = Number(args[++i]);
  else if (arg === '--out') options.out = args[++i];
  else if (arg === '--lang') options.lang = args[++i];
  else if (arg === '--curr') options.curr = args[++i];
}

if (!Number.isFinite(options.startPage) || options.startPage < 1) {
  throw new Error('Invalid --start-page');
}
if (!Number.isFinite(options.maxPages) || options.maxPages < 1) {
  throw new Error('Invalid --max-pages');
}
if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
  throw new Error('Invalid --delay-ms');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeHtml = (str) => str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
  if (code[0] === '#') {
    const isHex = code[1] === 'x' || code[1] === 'X';
    const num = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    return Number.isFinite(num) ? String.fromCodePoint(num) : m;
  }
  const map = {
    amp: '&',
    quot: '"',
    lt: '<',
    gt: '>',
    apos: "'",
    nbsp: ' ',
  };
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : m;
});

const parseSoldCount = (soldText) => {
  if (!soldText) return 0;
  const lowered = soldText.toLowerCase();
  const cleaned = lowered.replace(/[^0-9a-zа-я.,+]/g, '');
  const match = cleaned.match(/[\d.,]+/);
  if (!match) return 0;

  let num = parseFloat(match[0].replace(',', '.'));
  if (!Number.isFinite(num)) return 0;

  if (cleaned.includes('млрд') || cleaned.includes('b')) num *= 1_000_000_000;
  else if (cleaned.includes('млн') || cleaned.includes('m')) num *= 1_000_000;
  else if (cleaned.includes('тыс') || cleaned.includes('k')) num *= 1_000;

  return Math.round(num);
};

const parseResponse = (text) => {
  const first = text.indexOf('|');
  const second = text.indexOf('|', first + 1);
  if (first === -1 || second === -1) {
    return { page: null, count: null, html: text };
  }
  const page = text.slice(0, first).trim();
  const count = text.slice(first + 1, second).trim();
  const html = text.slice(second + 1);
  return { page, count, html };
};

const extractItems = (html) => {
  const items = [];
  const blockRegex = /<li class='section-list__item'>[\s\S]*?<\/li>/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[0];
    const productIdMatch = block.match(/product_id='(\d+)'/);
    const hrefMatch = block.match(/href='([^']+)'/);
    const titleMatch = block.match(/<p name='title'[^>]*>\s*<span[^>]*>(.*?)<\/span>/);
    const soldMatch = block.match(/<span name='sold'[^>]*>(.*?)<\/span>/);

    if (!productIdMatch || !hrefMatch || !titleMatch || !soldMatch) {
      continue;
    }

    const productId = productIdMatch[1];
    const rawUrl = hrefMatch[1];
    const url = rawUrl.startsWith('/') ? `https://plati.market${rawUrl}` : rawUrl;
    const title = decodeHtml(titleMatch[1]).replace(/\s+/g, ' ').trim();
    const soldText = decodeHtml(soldMatch[1]).replace(/\s+/g, ' ').trim();
    const soldCount = parseSoldCount(soldText);

    items.push({
      product_id: productId,
      url,
      title,
      sold_text: soldText,
      sold_count: soldCount,
    });
  }
  return items;
};

const fetchPage = async (page) => {
  const first = page === 1 ? 'true' : 'false';
  const url = `https://plati.market/asp/items2.asp?page=${page}&lang=${encodeURIComponent(options.lang)}&curr=${encodeURIComponent(options.curr)}&first=${first}&rnd=${Math.random()}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': options.userAgent,
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
};

const main = async () => {
  const results = [];
  const seen = new Set();

  for (let page = options.startPage; page < options.startPage + options.maxPages; page += 1) {
    const text = await fetchPage(page);
    const parsed = parseResponse(text);
    const html = parsed.html.trim();
    if (!html) {
      console.log(`Empty response at page ${page}, stopping.`);
      break;
    }
    const items = extractItems(html);
    if (!items.length) {
      console.log(`No items found at page ${page}, stopping.`);
      break;
    }

    for (const item of items) {
      const key = item.product_id;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }

    console.log(`Page ${page}: ${items.length} items (total ${results.length})`);
    if (options.delayMs) {
      await sleep(options.delayMs);
    }
  }

  fs.writeFileSync(options.out, JSON.stringify(results, null, 2) + '\n');
  console.log(`Saved ${results.length} items to ${options.out}`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
