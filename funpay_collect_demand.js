#!/usr/bin/env node
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const options = {
  home: 'funpay_home.html',
  titles: 'funpay_titles.txt',
  direct: 'funpay_direct_purchase_true.txt',
  remainingOut: 'funpay_remaining_titles.txt',
  mapOut: 'funpay_title_urls.json',
  out: 'funpay_demand_metrics.json',
  delayMs: 150,
  start: 0,
  limit: null,
  resume: false,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--home') options.home = args[++i];
  else if (arg === '--titles') options.titles = args[++i];
  else if (arg === '--direct') options.direct = args[++i];
  else if (arg === '--remaining-out') options.remainingOut = args[++i];
  else if (arg === '--map-out') options.mapOut = args[++i];
  else if (arg === '--out') options.out = args[++i];
  else if (arg === '--delay-ms') options.delayMs = Number(args[++i]);
  else if (arg === '--start') options.start = Number(args[++i]);
  else if (arg === '--limit') options.limit = Number(args[++i]);
  else if (arg === '--resume') options.resume = true;
}

if (!fs.existsSync(options.home)) {
  throw new Error(`Missing ${options.home}. Fetch FunPay homepage first.`);
}
if (!fs.existsSync(options.titles)) {
  throw new Error(`Missing ${options.titles}. Generate titles first.`);
}
if (!fs.existsSync(options.direct)) {
  throw new Error(`Missing ${options.direct}. Generate direct-purchase list first.`);
}
if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
  throw new Error('Invalid --delay-ms');
}
if (!Number.isFinite(options.start) || options.start < 0) {
  throw new Error('Invalid --start');
}
if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
  throw new Error('Invalid --limit');
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

const readLines = (filePath) => fs.readFileSync(filePath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const parseTitleUrls = (html) => {
  const regex = /<div class="game-title[^"]*"[^>]*>\s*<a href="([^"]+)">([^<]+)<\/a>/g;
  const map = new Map();
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawUrl = match[1].trim();
    const name = decodeHtml(match[2].trim());
    if (!name) continue;
    let url = rawUrl;
    if (url.startsWith('/')) {
      url = `https://funpay.com${url}`;
    }
    const list = map.get(name) || new Set();
    list.add(url);
    map.set(name, list);
  }
  return map;
};

const parseCounters = (html) => {
  const regex = /counter-param">\s*([^<]+?)\s*<\/div>\s*<div class="counter-value">\s*([^<]*?)\s*<\/div>/g;
  const counters = new Map();
  let match;
  while ((match = regex.exec(html)) !== null) {
    const category = decodeHtml(match[1]).replace(/\\s+/g, ' ').trim();
    const rawValue = decodeHtml(match[2]).replace(/\\s+/g, ' ').trim();
    const digits = rawValue.replace(/[^0-9]/g, '');
    const count = digits ? Number(digits) : 0;
    if (!category) continue;
    counters.set(category, (counters.get(category) || 0) + count);
  }
  return counters;
};

const fetchHtml = async (url, attempt = 1) => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': options.userAgent,
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
};

const main = async () => {
  const homeHtml = fs.readFileSync(options.home, 'utf8');
  const titleUrlMap = parseTitleUrls(homeHtml);
  const mapOut = {};
  for (const [name, urls] of titleUrlMap.entries()) {
    mapOut[name] = Array.from(urls);
  }
  fs.writeFileSync(options.mapOut, JSON.stringify(mapOut, null, 2) + '\n');

  const allTitles = readLines(options.titles);
  const direct = new Set(readLines(options.direct));
  const remaining = allTitles.filter((name) => !direct.has(name));
  fs.writeFileSync(options.remainingOut, `${remaining.join('\n')}\n`);

  const slice = remaining.slice(options.start, options.limit ? options.start + options.limit : undefined);

  const existing = [];
  const existingMap = new Map();
  if (options.resume && fs.existsSync(options.out)) {
    const prev = JSON.parse(fs.readFileSync(options.out, 'utf8'));
    if (Array.isArray(prev)) {
      for (const row of prev) {
        if (row && typeof row.name === 'string') {
          existing.push(row);
          existingMap.set(row.name, row);
        }
      }
    }
  }

  const results = existing.slice();
  const targets = slice.filter((name) => !existingMap.has(name));

  for (let i = 0; i < targets.length; i += 1) {
    const name = targets[i];
    const urls = titleUrlMap.get(name) ? Array.from(titleUrlMap.get(name)) : [];
    const categories = {};
    const sources = [];
    const errors = [];

    if (urls.length === 0) {
      errors.push('No URL found for title.');
    }

    for (let u = 0; u < urls.length; u += 1) {
      const url = urls[u];
      try {
        const html = await fetchHtml(url);
        const counters = parseCounters(html);
        const counterObj = {};
        for (const [category, count] of counters.entries()) {
          counterObj[category] = count;
          categories[category] = (categories[category] || 0) + count;
        }
        const totalOffers = Object.values(counterObj).reduce((sum, val) => sum + val, 0);
        sources.push({ url, total_offers: totalOffers, categories: counterObj });
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
      }
      if (options.delayMs) {
        await sleep(options.delayMs);
      }
    }

    const totalOffers = Object.values(categories).reduce((sum, val) => sum + val, 0);
    results.push({
      name,
      total_offers: totalOffers,
      categories,
      sources,
      errors,
    });

    console.log(`Processed ${i + 1}/${targets.length}: ${name} (${totalOffers})`);
  }

  const resultsMap = new Map(results.map((row) => [row.name, row]));
  const ordered = remaining.map((name) => resultsMap.get(name)).filter(Boolean);
  fs.writeFileSync(options.out, JSON.stringify(ordered, null, 2) + '\n');

  console.log(`Saved metrics to ${options.out}`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
