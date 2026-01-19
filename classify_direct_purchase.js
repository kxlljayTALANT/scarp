#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const options = {
  input: 'funpay_titles.txt',
  out: 'funpay_direct_purchase.json',
  trueOut: 'funpay_direct_purchase_true.txt',
  chunkSize: 25,
  limit: null,
  delayMs: 1200,
  model: process.env.XAI_MODEL || 'grok-3',
  resume: false,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--input') options.input = args[++i];
  else if (arg === '--out') options.out = args[++i];
  else if (arg === '--true-out') options.trueOut = args[++i];
  else if (arg === '--chunk-size') options.chunkSize = Number(args[++i]);
  else if (arg === '--limit') options.limit = Number(args[++i]);
  else if (arg === '--delay-ms') options.delayMs = Number(args[++i]);
  else if (arg === '--model') options.model = args[++i];
  else if (arg === '--resume') options.resume = true;
}

if (!Number.isFinite(options.chunkSize) || options.chunkSize <= 0) {
  throw new Error('Invalid --chunk-size');
}
if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
  throw new Error('Invalid --limit');
}

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  throw new Error('XAI_API_KEY is required in environment');
}

const readLines = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extractJson = (text) => {
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last < first) {
    throw new Error('No JSON array found in response');
  }
  const slice = text.slice(first, last + 1);
  return JSON.parse(slice);
};

const buildPrompt = (items) => {
  const examples = [
    { name: 'ChatGPT', direct_purchase: true, reason: 'Paid plan on official site.' },
    { name: 'ExitLag', direct_purchase: true, reason: 'Subscription on official site.' },
    { name: 'Fortnite', direct_purchase: false, reason: 'Purchases handled by Epic/console stores.' },
    { name: 'Steam', direct_purchase: false, reason: 'Marketplace/store platform, not a single product site.' },
  ];
  const exampleText = examples
    .map((ex) => `{"name":"${ex.name}","direct_purchase":${ex.direct_purchase},"reason":"${ex.reason}"}`)
    .join(',\n');

  return [
    'Classify each item name.',
    'direct_purchase = true ONLY if the official website sells subscriptions or digital goods directly (card/PayPal) without redirecting to Steam, Battle.net, Epic, PlayStation Store, Xbox, App Store, Google Play, or other third-party stores.',
    'If unsure or likely third-party store is required, set direct_purchase = false.',
    'Return ONLY a JSON array of objects with keys: name, direct_purchase, reason.',
    'Keep item names EXACTLY as provided and in the SAME order.',
    'Examples:',
    `[${exampleText}]`,
    'Items:',
    items.map((item) => `- ${item}`).join('\n'),
  ].join('\n');
};

const callXai = async (items, attempt) => {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'You are a strict classifier that returns only JSON.',
        },
        {
          role: 'user',
          content: buildPrompt(items),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`xAI API error: ${response.status} ${response.statusText} ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  try {
    return extractJson(content);
  } catch (err) {
    if (attempt >= 2) {
      throw new Error(`Failed to parse JSON after ${attempt} attempts: ${err.message}`);
    }
    return null;
  }
};

const normalizeResults = (items, parsed) => {
  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (row && typeof row.name === 'string') {
        map.set(row.name, row);
      }
    }
  }
  return items.map((name) => {
    const hit = map.get(name);
    if (!hit) {
      return { name, direct_purchase: false, reason: 'Missing from model output.' };
    }
    return {
      name,
      direct_purchase: Boolean(hit.direct_purchase),
      reason: typeof hit.reason === 'string' ? hit.reason.trim() : 'No reason provided.',
    };
  });
};

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const main = async () => {
  let titles = readLines(options.input);
  if (options.limit) titles = titles.slice(0, options.limit);

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

  const remaining = titles.filter((name) => !existingMap.has(name));
  const chunks = chunk(remaining, options.chunkSize);
  const results = existing.slice();

  for (let i = 0; i < chunks.length; i += 1) {
    const items = chunks[i];
    const attempt1 = await callXai(items, 1);
    const parsed = attempt1 || (await callXai(items, 2));
    const normalized = normalizeResults(items, parsed);
    results.push(...normalized);
    console.log(`Processed chunk ${i + 1}/${chunks.length} (${results.length}/${titles.length})`);
    if (i < chunks.length - 1) {
      await sleep(options.delayMs);
    }
  }

  const final = titles.map((name) => existingMap.get(name) || results.find((row) => row.name === name));
  fs.writeFileSync(options.out, JSON.stringify(final, null, 2) + '\n');

  const direct = final.filter((row) => row && row.direct_purchase);
  const directNames = direct.map((row) => row.name).join('\n');
  fs.writeFileSync(options.trueOut, `${directNames}\n`);

  console.log(`Saved results to ${options.out}`);
  console.log(`Saved direct-purchase list to ${options.trueOut}`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
