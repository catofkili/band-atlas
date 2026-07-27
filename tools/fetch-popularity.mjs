#!/usr/bin/env node
/**
 * 为现有乐队补 ListenBrainz 历史收听量。只查已经收录的 MBID，不扩充乐队名单。
 * 每支结果单独缓存；中断后重跑会从上次位置继续。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache/listenbrainz-artists');
const source = JSON.parse(await readFile(path.join(root, 'data/source/generated.json'), 'utf8'));
const modernJapan = JSON.parse(
  await readFile(path.join(root, 'data/source/modern-japan.json'), 'utf8')
);
const curated = JSON.parse(await readFile(path.join(root, 'data/source/scene-jrock.json'), 'utf8'));
const greaterChina = JSON.parse(
  await readFile(path.join(root, 'data/source/greater-china.json'), 'utf8')
);
const bands = [...source.bands, ...modernJapan.bands, ...curated.bands, ...greaterChina.bands]
  .filter((band) => band.mbid)
  .sort((a, b) => a.mbid.localeCompare(b.mbid));
const unique = [...new Map(bands.map((band) => [band.mbid, band])).values()];
const concurrency = 6;

await mkdir(cacheDir, { recursive: true });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function cached(mbid) {
  try {
    return JSON.parse(await readFile(path.join(cacheDir, `${mbid}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function fetchOne(band) {
  const hit = await cached(band.mbid);
  if (hit) return { ...hit, cached: true };
  const url =
    `https://api.listenbrainz.org/1/stats/artist/${band.mbid}/listeners?range=all_time`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (response.status === 204 || response.status === 404) {
        const empty = {
          mbid: band.mbid,
          name: band.name,
          listens: 0,
          listeners: 0,
          updatedAt: new Date().toISOString(),
        };
        await writeFile(path.join(cacheDir, `${band.mbid}.json`), JSON.stringify(empty));
        return empty;
      }
      if (response.status === 429 || response.status >= 500) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const result = {
        mbid: band.mbid,
        name: data.payload?.artist_name ?? band.name,
        listens: data.payload?.total_listen_count ?? 0,
        listeners: data.payload?.total_user_count ?? data.payload?.listeners?.length ?? 0,
        updatedAt: new Date().toISOString(),
      };
      await writeFile(path.join(cacheDir, `${band.mbid}.json`), JSON.stringify(result));
      return result;
    } catch (error) {
      if (attempt === 3) {
        return { mbid: band.mbid, name: band.name, error: error.message };
      }
      await sleep(750 * (attempt + 1));
    }
  }
}

const results = new Array(unique.length);
let cursor = 0;
let completed = 0;
let misses = 0;
async function worker() {
  while (cursor < unique.length) {
    const index = cursor++;
    const result = await fetchOne(unique[index]);
    results[index] = result;
    completed += 1;
    if (!result.cached) misses += 1;
    if (completed % 25 === 0 || completed === unique.length) {
      console.log(`  ListenBrainz ${completed}/${unique.length}（本次请求 ${misses}）`);
    }
    await sleep(80);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const artists = Object.fromEntries(
  results
    .filter((result) => !result.error)
    .map(({ mbid, name, listens, listeners, updatedAt }) => [
      mbid,
      { name, listens, listeners, updatedAt },
    ])
);
const failures = results
  .filter((result) => result.error)
  .map(({ mbid, name, error }) => ({ mbid, name, error }));
await writeFile(
  path.join(root, 'data/source/popularity.json'),
  JSON.stringify(
    {
      note: '现有乐队的 ListenBrainz 历史总收听量与独立听众数；不用于扩充名单。',
      generatedAt: new Date().toISOString(),
      artists,
      failures,
    },
    null,
    2
  ) + '\n'
);
console.log(`✓ 热度 ${Object.keys(artists).length} 支，失败 ${failures.length} 支`);
