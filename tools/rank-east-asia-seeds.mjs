#!/usr/bin/env node
/**
 * 将东亚候选按 ListenBrainz 的总收听量排序，输出给 crawl.mjs 使用。
 * 名称只用来初次认领 MusicBrainz ID；之后排序完全使用真实 MBID 与收听量。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, mbSearchArtist, mbArtist } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/mb'));
const EAST = new Set(['JP', 'KR', 'KP', 'CN', 'TW', 'HK', 'MO', 'MN']);
const source = JSON.parse(await readFile(path.join(root, 'data/source/east-asia-seeds.json'), 'utf8'));
const seeds = [];

for (const name of source.seeds) {
  const search = await mbSearchArtist(name);
  const rough = (search?.artists ?? []).find((a) => a.type === 'Group');
  if (!rough) continue;
  const artist = await mbArtist(rough.id);
  if (artist?.type !== 'Group' || !EAST.has(artist.country ?? artist.area?.['iso-3166-1-codes']?.[0])) continue;
  seeds.push({ name: artist.name, mbid: artist.id, countryCode: artist.country ?? artist.area?.['iso-3166-1-codes']?.[0] });
}

const popularity = new Map();
for (let i = 0; i < seeds.length; i += 25) {
  const batch = seeds.slice(i, i + 25);
  let rows = null;
  for (let attempt = 0; attempt < 3 && !rows; attempt++) {
    const res = await fetch('https://api.listenbrainz.org/1/popularity/artist', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artist_mbids: batch.map((s) => s.mbid) }),
    });
    if (res.ok) rows = await res.json();
    else await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
  }
  if (!rows) throw new Error(`ListenBrainz 热度请求连续失败（第 ${i + 1} 批）`);
  for (const row of rows) popularity.set(row.artist_mbid, row.total_listen_count ?? 0);
}

const ranked = [...new Map(seeds.map((s) => [s.mbid, s])).values()]
  .map((s) => ({ ...s, listens: popularity.get(s.mbid) ?? 0 }))
  .sort((a, b) => b.listens - a.listens || a.name.localeCompare(b.name))
  .map((s, i) => ({ ...s, rank: i + 1 }));

await writeFile(path.join(root, 'data/source/east-asia-ranked-seeds.json'), JSON.stringify({
  note: '东亚候选经 MusicBrainz 国家代码确认后，按 ListenBrainz 历史总收听量降序排列。',
  generatedAt: new Date().toISOString(), seeds: ranked,
}, null, 2) + '\n');
console.log(`✓ ${ranked.length} 支东亚乐队已按 ListenBrainz 热度排序`);
