#!/usr/bin/env node
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const options = {
  input: 'plati_items_raw.json',
  out: 'plati_items_classified.json',
  chunkSize: 20,
  delayMs: 1200,
  model: process.env.XAI_MODEL || 'grok-3',
  resume: false,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--input') options.input = args[++i];
  else if (arg === '--out') options.out = args[++i];
  else if (arg === '--chunk-size') options.chunkSize = Number(args[++i]);
  else if (arg === '--delay-ms') options.delayMs = Number(args[++i]);
  else if (arg === '--model') options.model = args[++i];
  else if (arg === '--resume') options.resume = true;
}

if (!Number.isFinite(options.chunkSize) || options.chunkSize <= 0) {
  throw new Error('Invalid --chunk-size');
}
if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
  throw new Error('Invalid --delay-ms');
}
if (!fs.existsSync(options.input)) {
  throw new Error(`Missing ${options.input}`);
}

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  throw new Error('XAI_API_KEY is required in environment');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extractJson = (text) => {
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last < first) {
    throw new Error('No JSON array found in response');
  }
  return JSON.parse(text.slice(first, last + 1));
};

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const buildPrompt = (items) => {
  const lines = items.map((item) => (
    `- product_id=${item.product_id} | title="${item.title}" | url=${item.url}`
  ));

  return [
    'Нужно определить сервис и отфильтровать позиции.',
    'Для каждого пункта верни: product_id, service, keep, reason.',
    'service: краткое нормализованное имя сервиса/платформы (например: Steam, PlayStation, ChatGPT).',
    'keep=true ТОЛЬКО если у сервиса есть официальная возможность купить подписку, пополнить баланс или сделать донат прямо на официальном сайте/приложении сервиса.',
    'Если это ключ игры, аккаунт, буст, услуги, либо покупка через сторонние магазины (Steam/Epic/PSN/Xbox/App Store/Google Play и т.п.) — keep=false.',
    'Если сомневаешься — keep=false.',
    'Верни ТОЛЬКО JSON массив объектов. Сохрани порядок исходного списка.',
    'Пункты:',
    lines.join('\n'),
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
        { role: 'system', content: 'Return only JSON. No extra text.' },
        { role: 'user', content: buildPrompt(items) },
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

const normalize = (items, parsed) => {
  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (row && typeof row.product_id === 'string') {
        map.set(row.product_id, row);
      }
    }
  }
  return items.map((item) => {
    const hit = map.get(item.product_id) || {};
    return {
      product_id: item.product_id,
      title: item.title,
      url: item.url,
      service: typeof hit.service === 'string' ? hit.service.trim() : 'Unknown',
      keep: Boolean(hit.keep),
      reason: typeof hit.reason === 'string' ? hit.reason.trim() : 'No reason provided.',
    };
  });
};

const main = async () => {
  const items = JSON.parse(fs.readFileSync(options.input, 'utf8'));
  if (!Array.isArray(items)) {
    throw new Error('Input file is not a JSON array.');
  }

  const existing = [];
  const existingMap = new Map();
  if (options.resume && fs.existsSync(options.out)) {
    const prev = JSON.parse(fs.readFileSync(options.out, 'utf8'));
    if (Array.isArray(prev)) {
      for (const row of prev) {
        if (row && typeof row.product_id === 'string') {
          existing.push(row);
          existingMap.set(row.product_id, row);
        }
      }
    }
  }

  const remaining = items.filter((item) => !existingMap.has(item.product_id));
  const batches = chunk(remaining, options.chunkSize);
  const results = existing.slice();

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const attempt1 = await callXai(batch, 1);
    const parsed = attempt1 || (await callXai(batch, 2));
    const normalized = normalize(batch, parsed);
    results.push(...normalized);
    console.log(`Processed chunk ${i + 1}/${batches.length} (${results.length}/${items.length})`);
    if (i < batches.length - 1) {
      await sleep(options.delayMs);
    }
  }

  const resultsMap = new Map(results.map((row) => [row.product_id, row]));
  const ordered = items.map((item) => resultsMap.get(item.product_id)).filter(Boolean);
  fs.writeFileSync(options.out, JSON.stringify(ordered, null, 2) + '\n');
  console.log(`Saved ${options.out}`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
