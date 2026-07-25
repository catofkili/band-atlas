#!/usr/bin/env node
/**
 * 从 Wikidata 补「受谁影响」的关系。
 *
 * P737 的方向是「乐队 A influenced by 乐队/音乐人 B」。为了只写可验证的
 * 乐队关系网，这里只留下 A、B 都能用 MusicBrainz P434 对应到当前数据集的记录。
 *
 *   node tools/fetch-influences.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, sparql, stats } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/mb'));

const generated = JSON.parse(await readFile(path.join(root, 'data/source/generated.json'), 'utf8'));
const byMbid = new Map(generated.bands.filter((b) => b.mbid).map((b) => [b.mbid, b.id]));
const mbids = [...byMbid.keys()];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const found = new Map();
for (const [i, batch] of chunk(mbids, 100).entries()) {
  const values = batch.map((id) => `"${id}"`).join(' ');
  const rows = await sparql(`
    SELECT DISTINCT ?fromMbid ?toMbid WHERE {
      VALUES ?fromMbid { ${values} }
      ?from wdt:P434 ?fromMbid ; wdt:P737 ?to .
      ?to wdt:P434 ?toMbid .
    }`);
  for (const row of rows) {
    const from = byMbid.get(row.fromMbid.value);
    const to = byMbid.get(row.toMbid.value);
    if (from && to && from !== to) found.set([from, to].sort().join('|'), { from, to });
  }
  log(`Wikidata 批次 ${i + 1}/${Math.ceil(mbids.length / 100)}：网内影响关系 ${found.size} 条`);
}

const edges = [...found.values()].map(({ from, to }) => {
  // P737 的方向是 from 受 to 影响；网页会把边双向展示，
  // 所以同时写反向文案，不能让 Beatles 卡片上看起来像是「Beatles 受 Pixies 影响」。
  const fromName = generated.bands.find((b) => b.id === from)?.name ?? from;
  const toName = generated.bands.find((b) => b.id === to)?.name ?? to;
  return {
    from,
    to,
    type: 'influence',
    label: '影响关系',
    detail: `${fromName} 受 ${toName} 影响（Wikidata）。`,
    detailRev: `${toName} 影响了 ${fromName}（Wikidata）。`,
    weight: 0.46,
  };
});

await writeFile(
  path.join(root, 'data/source/influences.json'),
  JSON.stringify({ note: '由 tools/fetch-influences.mjs 从 Wikidata P737 生成，请勿手改。', edges }, null, 2) + '\n'
);
const c = stats();
log(`✓ ${edges.length} 条影响关系 → data/source/influences.json`);
log(`  接口调用 ${c.misses} 次，命中缓存 ${c.hits} 次`);
