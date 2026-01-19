#!/usr/bin/env node
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const options = {
  input: 'funpay_demand_metrics.json',
  outJson: 'funpay_demand_ranked.json',
  outTxt: 'funpay_demand_ranked.txt',
  chunkSize: 30,
  delayMs: 1200,
  model: process.env.XAI_MODEL || 'grok-3',
  resume: false,
  classifyOut: 'funpay_demand_classified.json',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--input') options.input = args[++i];
  else if (arg === '--out-json') options.outJson = args[++i];
  else if (arg === '--out-txt') options.outTxt = args[++i];
  else if (arg === '--chunk-size') options.chunkSize = Number(args[++i]);
  else if (arg === '--delay-ms') options.delayMs = Number(args[++i]);
  else if (arg === '--model') options.model = args[++i];
  else if (arg === '--resume') options.resume = true;
  else if (arg === '--classify-out') options.classifyOut = args[++i];
}

if (!Number.isFinite(options.chunkSize) || options.chunkSize <= 0) {
  throw new Error('Invalid --chunk-size');
}
if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
  throw new Error('Invalid --delay-ms');
}
if (!fs.existsSync(options.input)) {
  throw new Error(`Missing ${options.input}. Run collection first.`);
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

const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
};

const buildPrompt = (items, thresholds) => {
  const lines = items.map((item) => {
    const top = item.top_categories.length
      ? item.top_categories.map((entry) => `${entry.category}=${entry.count}`).join(', ')
      : 'нет данных';
    return `- ${item.name} | total_offers=${item.total_offers} | top_categories: ${top}`;
  });

  return [
    'Classify demand using FunPay counters.',
    'total_offers = total active listings summed across categories (from FunPay counters).',
    'Use thresholds:',
    `very_high >= ${thresholds.p90}`,
    `high >= ${thresholds.p75}`,
    `medium >= ${thresholds.p50}`,
    `low >= ${thresholds.p25}`,
    `very_low < ${thresholds.p25}`,
    'Return ONLY a JSON array with objects: name, demand_level, note.',
    'Keep item names EXACTLY as provided and in the SAME order.',
    'Items:',
    lines.join('\n'),
  ].join('\n');
};

const callXai = async (items, thresholds, attempt) => {
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
        { role: 'user', content: buildPrompt(items, thresholds) },
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
      if (row && typeof row.name === 'string') {
        map.set(row.name, row);
      }
    }
  }
  return items.map((item) => {
    const hit = map.get(item.name);
    return {
      name: item.name,
      demand_level: hit?.demand_level || 'unknown',
      note: typeof hit?.note === 'string' ? hit.note.trim() : 'No note provided.',
    };
  });
};

const main = async () => {
  const metrics = JSON.parse(fs.readFileSync(options.input, 'utf8'));
  if (!Array.isArray(metrics)) {
    throw new Error('Metrics file is not a JSON array.');
  }

  const items = metrics.map((row) => {
    const categories = row.categories || {};
    const topCategories = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, count]) => ({ category, count }));
    return {
      name: row.name,
      total_offers: Number(row.total_offers) || 0,
      top_categories: topCategories,
      sources: row.sources || [],
    };
  });

  const totals = items.map((item) => item.total_offers).sort((a, b) => a - b);
  const thresholds = {
    p90: percentile(totals, 0.9),
    p75: percentile(totals, 0.75),
    p50: percentile(totals, 0.5),
    p25: percentile(totals, 0.25),
  };

  const existing = [];
  const existingMap = new Map();
  if (options.resume && fs.existsSync(options.classifyOut)) {
    const prev = JSON.parse(fs.readFileSync(options.classifyOut, 'utf8'));
    if (Array.isArray(prev)) {
      for (const row of prev) {
        if (row && typeof row.name === 'string') {
          existing.push(row);
          existingMap.set(row.name, row);
        }
      }
    }
  }

  const remaining = items.filter((item) => !existingMap.has(item.name));
  const batches = chunk(remaining, options.chunkSize);
  const classified = existing.slice();

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const attempt1 = await callXai(batch, thresholds, 1);
    const parsed = attempt1 || (await callXai(batch, thresholds, 2));
    const normalized = normalize(batch, parsed);
    classified.push(...normalized);
    console.log(`Classified chunk ${i + 1}/${batches.length} (${classified.length}/${items.length})`);
    if (i < batches.length - 1) {
      await sleep(options.delayMs);
    }
  }

  const classifiedMap = new Map(classified.map((row) => [row.name, row]));
  const ranked = items
    .slice()
    .sort((a, b) => b.total_offers - a.total_offers)
    .map((item, index) => ({
      rank: index + 1,
      name: item.name,
      total_offers: item.total_offers,
      demand_level: classifiedMap.get(item.name)?.demand_level || 'unknown',
      note: classifiedMap.get(item.name)?.note || 'No note provided.',
      top_categories: item.top_categories,
      sources: item.sources,
    }));

  fs.writeFileSync(options.classifyOut, JSON.stringify(classified, null, 2) + '\n');
  fs.writeFileSync(options.outJson, JSON.stringify(ranked, null, 2) + '\n');

  const lines = ranked.map((row) => (
    `${row.rank}\t${row.name}\t${row.total_offers}\t${row.demand_level}\t${row.top_categories.map((c) => `${c.category}=${c.count}`).join(', ')}`
  ));
  fs.writeFileSync(options.outTxt, `${lines.join('\n')}\n`);

  console.log(`Saved ranked list to ${options.outTxt}`);
  console.log(`Saved ranked JSON to ${options.outJson}`);
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
