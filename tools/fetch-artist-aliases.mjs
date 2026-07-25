#!/usr/bin/env node
/**
 * 批量取 MusicBrainz 艺人别名，供全局搜索使用。
 * 一批查多个 MBID，避免为上千个节点逐个请求。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, getJSON, stats } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/artist-aliases'));
const readJSON = async (rel, fallback) => {
  try {
    return JSON.parse(await readFile(path.join(root, rel), 'utf8'));
  } catch {
    return fallback;
  }
};
const generated = await readJSON('data/source/generated.json', { bands: [] });
const curated = await readJSON('data/source/scene-jrock.json', { bands: [] });
const modern = await readJSON('data/source/modern-japan.json', { bands: [] });
const mbids = [...new Set(
  [...generated.bands, ...curated.bands, ...modern.bands]
    .map((band) => band.mbid)
    .filter(Boolean)
)].sort();
const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size)
  );
const artists = {};
const batches = chunks(mbids, 32);

for (const [index, batch] of batches.entries()) {
  const query = `arid:(${batch.join(' OR ')})`;
  const url =
    `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(query)}` +
    `&fmt=json&limit=100`;
  const data = await getJSON(url);
  for (const artist of data?.artists ?? []) {
    const aliases = [
      artist['sort-name'],
      ...(artist.aliases ?? []).map((alias) => alias.name),
    ].filter(Boolean);
    artists[artist.id] = [...new Set(aliases)];
  }
  console.log(`  别名 ${index + 1}/${batches.length} · 已覆盖 ${Object.keys(artists).length} 位`);
}

await writeFile(
  path.join(root, 'data/source/artist-aliases.json'),
  JSON.stringify({
    note: 'MusicBrainz sort-name 与 aliases，供全局多文字搜索使用。',
    generatedAt: new Date().toISOString(),
    artists,
  }, null, 2) + '\n'
);
console.log(
  `✓ ${Object.keys(artists).length}/${mbids.length} 位有 MusicBrainz 搜索资料；` +
  `缓存 ${stats().hits}，请求 ${stats().misses}`
);
