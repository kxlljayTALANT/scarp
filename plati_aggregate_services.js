#!/usr/bin/env node
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const options = {
  items: 'plati_items_raw.json',
  classified: 'plati_items_classified.json',
  outTxt: 'plati_services_ranked.txt',
  outJson: 'plati_services_ranked.json',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--items') options.items = args[++i];
  else if (arg === '--classified') options.classified = args[++i];
  else if (arg === '--out-txt') options.outTxt = args[++i];
  else if (arg === '--out-json') options.outJson = args[++i];
}

if (!fs.existsSync(options.items)) {
  throw new Error(`Missing ${options.items}`);
}
if (!fs.existsSync(options.classified)) {
  throw new Error(`Missing ${options.classified}`);
}

const items = JSON.parse(fs.readFileSync(options.items, 'utf8'));
const classified = JSON.parse(fs.readFileSync(options.classified, 'utf8'));

if (!Array.isArray(items) || !Array.isArray(classified)) {
  throw new Error('Input files must be JSON arrays.');
}

const itemMap = new Map(items.map((item) => [item.product_id, item]));
const groups = new Map();

for (const row of classified) {
  if (!row || !row.product_id || !row.keep) continue;
  const item = itemMap.get(row.product_id);
  if (!item) continue;

  const service = row.service && row.service.trim() ? row.service.trim() : 'Unknown';
  const current = groups.get(service) || {
    service,
    offers_count: 0,
    sold_total: 0,
    products: [],
  };
  current.offers_count += 1;
  current.sold_total += Number(item.sold_count) || 0;
  current.products.push({
    product_id: item.product_id,
    title: item.title,
    sold_count: item.sold_count,
    sold_text: item.sold_text,
    url: item.url,
  });
  groups.set(service, current);
}

const ranked = Array.from(groups.values()).sort((a, b) => b.sold_total - a.sold_total);

fs.writeFileSync(options.outJson, JSON.stringify(ranked, null, 2) + '\n');

const lines = ranked.map((row, index) => (
  `${index + 1}. ${row.service} - ${row.offers_count} ${row.sold_total}`
));
fs.writeFileSync(options.outTxt, `${lines.join('\n')}\n`);

console.log(`Saved ${options.outTxt}`);
