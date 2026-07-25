#!/usr/bin/env node
/**
 * 只为现有乐队补 Wikidata 流派与代表作品候选，不扩充名单。
 * 代表曲按 Wikidata sitelink 数排序：它不是收听量，但能稳定筛出被多语种条目反复记录的作品。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, sparql, stats } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/wikidata-enrichment'));
const generated = JSON.parse(await readFile(path.join(root, 'data/source/generated.json'), 'utf8'));
const modern = JSON.parse(await readFile(path.join(root, 'data/source/modern-japan.json'), 'utf8'));
const mbids = [...new Set([...generated.bands, ...modern.bands].map((band) => band.mbid).filter(Boolean))].sort();
const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size)
  );
const genreNames = new Map();
const works = new Map();

function firstLabel(row) {
  return row.zh?.value ?? row.ja?.value ?? row.ko?.value ?? row.en?.value ?? null;
}

for (const [index, batch] of chunks(mbids, 70).entries()) {
  const values = batch.map((mbid) => `"${mbid}"`).join(' ');
  const rows = await sparql(`
    SELECT ?mbid ?genre ?zh ?ja ?ko ?en WHERE {
      VALUES ?mbid { ${values} }
      ?artist wdt:P434 ?mbid ; wdt:P136 ?genre .
      OPTIONAL { ?genre rdfs:label ?zh FILTER(LANG(?zh) = "zh") }
      OPTIONAL { ?genre rdfs:label ?ja FILTER(LANG(?ja) = "ja") }
      OPTIONAL { ?genre rdfs:label ?ko FILTER(LANG(?ko) = "ko") }
      OPTIONAL { ?genre rdfs:label ?en FILTER(LANG(?en) = "en") }
    }`);
  for (const row of rows) {
    const label = firstLabel(row);
    if (!label) continue;
    const list = genreNames.get(row.mbid.value) || [];
    if (!list.includes(label)) list.push(label);
    genreNames.set(row.mbid.value, list);
  }
  console.log(`  Wikidata 流派 ${index + 1}/${Math.ceil(mbids.length / 70)} · 命中 ${genreNames.size}`);
}

for (const [index, batch] of chunks(mbids, 45).entries()) {
  const values = batch.map((mbid) => `"${mbid}"`).join(' ');
  const rows = await sparql(`
    SELECT ?mbid ?work ?sitelinks ?zh ?ja ?ko ?en WHERE {
      VALUES ?mbid { ${values} }
      ?artist wdt:P434 ?mbid .
      ?work wdt:P175 ?artist ; wdt:P31 ?kind ; wikibase:sitelinks ?sitelinks .
      VALUES ?kind { wd:Q7366 wd:Q134556 }
      OPTIONAL { ?work rdfs:label ?zh FILTER(LANG(?zh) = "zh") }
      OPTIONAL { ?work rdfs:label ?ja FILTER(LANG(?ja) = "ja") }
      OPTIONAL { ?work rdfs:label ?ko FILTER(LANG(?ko) = "ko") }
      OPTIONAL { ?work rdfs:label ?en FILTER(LANG(?en) = "en") }
    }`);
  for (const row of rows) {
    const title = firstLabel(row);
    if (!title) continue;
    const list = works.get(row.mbid.value) || [];
    const qid = row.work.value.split('/').pop();
    const existing = list.find((item) => item.qid === qid);
    const candidate = {
      qid,
      title,
      sitelinks: Number(row.sitelinks?.value ?? 0),
      source: row.work.value,
    };
    if (!existing) list.push(candidate);
    else if (candidate.sitelinks > existing.sitelinks) Object.assign(existing, candidate);
    works.set(row.mbid.value, list);
  }
  console.log(`  Wikidata 作品 ${index + 1}/${Math.ceil(mbids.length / 45)} · 命中 ${works.size}`);
}

const genres = Object.fromEntries(
  [...genreNames].map(([mbid, labels]) => [mbid, labels.slice(0, 6)])
);
const tracks = Object.fromEntries(
  [...works].map(([mbid, items]) => [
    mbid,
    items
      .sort((a, b) => b.sitelinks - a.sitelinks || a.title.localeCompare(b.title))
      .slice(0, 5),
  ])
);
await writeFile(
  path.join(root, 'data/source/wikidata-enrichment.json'),
  JSON.stringify(
    {
      note: '现有乐队的 Wikidata 流派与作品候选。作品按 sitelink 数排序，不等同于实际收听量。',
      generatedAt: new Date().toISOString(),
      genres,
      tracks,
    },
    null,
    2
  ) + '\n'
);
const requestStats = stats();
console.log(
  `✓ Wikidata：流派 ${Object.keys(genres).length} 支，代表作品 ${Object.keys(tracks).length} 支；` +
  `接口 ${requestStats.misses} 次，缓存 ${requestStats.hits} 次`
);
