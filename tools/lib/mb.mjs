/**
 * MusicBrainz / Wikidata 取数的公共部分：限速、落盘缓存、失败重试。
 *
 * MusicBrainz 对匿名调用限一秒一次，而且必须带能联系到人的 User-Agent，
 * 超了会被封。爬几百支乐队要跑二十分钟以上，所以每个响应都存到磁盘：
 * 中途断了、或者要调爬取策略重跑，都不必再打一次接口。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const UA = 'BandAtlas/0.1 ( https://github.com/catofkili/band-atlas )';
const MIN_GAP_MS = 1100; // 官方限一秒一次，留点余量

let lastCall = 0;
let cacheDir = null;
let hits = 0;
let misses = 0;

export function useCache(dir) {
  cacheDir = dir;
}

export function stats() {
  return { hits, misses };
}

const keyFor = (url) => createHash('sha1').update(url).digest('hex') + '.json';

async function readCache(url) {
  if (!cacheDir) return null;
  try {
    return JSON.parse(await readFile(path.join(cacheDir, keyFor(url)), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(url, data) {
  if (!cacheDir) return;
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, keyFor(url)), JSON.stringify(data));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 限速 + 缓存的 GET。返回解析好的 JSON；彻底失败返回 null，让调用方跳过。 */
export async function getJSON(url, { retries = 3 } = {}) {
  const cached = await readCache(url);
  if (cached) {
    hits++;
    return cached;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      // 503 是限速在抗议，退避后重来；其余 4xx 直接放弃，重试也没用
      if (res.status === 503 || res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      await writeCache(url, data);
      misses++;
      return data;
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

const MB = 'https://musicbrainz.org/ws/2';

export const mbArtist = (mbid) =>
  getJSON(`${MB}/artist/${mbid}?inc=aliases+artist-rels+tags&fmt=json`);

export const mbSearchArtist = (name) =>
  getJSON(`${MB}/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`);

export const mbReleaseGroups = (mbid) =>
  getJSON(`${MB}/release-group?artist=${mbid}&type=album&fmt=json&limit=100`);

export const mbReleaseGroupsOfType = (mbid, type) =>
  getJSON(`${MB}/release-group?artist=${mbid}&type=${encodeURIComponent(type)}&fmt=json&limit=100`);

/** Wikidata SPARQL，一次问一批，别一个个问。 */
export async function sparql(query) {
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
  const data = await getJSON(url);
  return data?.results?.bindings ?? [];
}
