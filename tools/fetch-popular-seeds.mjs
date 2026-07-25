#!/usr/bin/env node
/**
 * 取 ListenBrainz 全站收听榜，作为扩展乐队时的唯一热门度顺序。
 *
 * MusicBrainz 没有可用于全库排序的 popularity 字段；ListenBrainz 与它使用
 * 相同的 MBID，且公开提供站内总收听量排名。这里原样保留排名，crawl.mjs
 * 会在真正扩展前跳过个人艺人，只接纳乐队。
 *
 *   node tools/fetch-popular-seeds.mjs [--count 1000]
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, getJSON, stats } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/listenbrainz'));
const raw = process.argv[process.argv.indexOf('--count') + 1];
const count = Math.min(1000, Math.max(1, Number(raw) || 1000));
const url = `https://api.listenbrainz.org/1/stats/sitewide/artists?range=all_time&count=${count}`;
const data = await getJSON(url);
const seeds = (data?.payload?.artists ?? [])
  .filter((artist) => artist.artist_mbid)
  .map((artist, i) => ({
    mbid: artist.artist_mbid,
    name: artist.artist_name,
    listens: artist.listen_count ?? 0,
    rank: i + 1,
  }));

await writeFile(
  path.join(root, 'data/source/popular-seeds.json'),
  JSON.stringify(
    {
      note: 'ListenBrainz 全站 all_time 收听量榜；crawl.mjs 会按此顺序扩展，并过滤非乐队条目。',
      fetchedAt: new Date().toISOString(),
      seeds,
    },
    null,
    2
  ) + '\n'
);
const c = stats();
console.log(`✓ ListenBrainz 热门榜 ${seeds.length} 位 → data/source/popular-seeds.json`);
console.log(`  接口调用 ${c.misses} 次，命中缓存 ${c.hits} 次`);
