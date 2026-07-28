#!/usr/bin/env node
/**
 * 为全站乐队补流媒体艺人主页。
 *
 * 证据优先级：
 *   1. data/source/music-links.json 里已有的人工核对链接
 *   2. Wikidata 通过 MusicBrainz artist ID 对齐的外部 ID
 *   3. MusicBrainz 的 URL relationships
 *   4. QQ / 网易云 / Apple Music 搜索中的精确名称或正式别名匹配
 *
 * 所有网络结果都会写进 .cache/music-links/progress.json。脚本中断后重跑会
 * 从缓存继续，不会重新请求已经完成的 MusicBrainz 条目和平台搜索。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, '.cache/music-links');
const cacheFile = path.join(cacheDir, 'progress.json');
const outputFile = path.join(root, 'data/source/music-links.json');
const USER_AGENT = 'BandAtlas/1.0 (https://github.com/catofkili/band-atlas)';
const PLATFORMS = ['qq', 'netease', 'apple', 'spotify'];
const args = new Set(process.argv.slice(2));
const SEARCH_CONCURRENCY = Number(
  process.argv.find((arg) => arg.startsWith('--concurrency='))?.split('=')[1] ?? 4
);
const SKIP_MUSICBRAINZ = args.has('--skip-musicbrainz');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJSON = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const norm = (text) =>
  (text ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/\p{M}/gu, '')
    .replace(/\p{P}|\p{S}|\s/gu, '');
const unique = (values) => [...new Set(values.filter(Boolean))];

await mkdir(cacheDir, { recursive: true });
const index = await readJSON(path.join(root, 'data/index.json'), { bands: [] });
const current = await readJSON(outputFile, { artists: {} });
const cache = await readJSON(cacheFile, {
  wikidataDone: false,
  wikidata: {},
  musicbrainz: {},
  searches: { qq: {}, netease: {}, apple: {} },
});
cache.wikidata ??= {};
cache.musicbrainz ??= {};
cache.searches ??= {};
for (const platform of ['qq', 'netease', 'apple']) cache.searches[platform] ??= {};
cache.catalogs ??= {};
for (const platform of ['qq', 'netease', 'apple']) cache.catalogs[platform] ??= {};

const bandFiles = (await readdir(path.join(root, 'data/bands')))
  .filter((file) => file.endsWith('.json'));
const indexById = new Map(index.bands.map((band) => [band.id, band]));
const bands = (await Promise.all(
  bandFiles.map((file) => readJSON(path.join(root, 'data/bands', file), null))
))
  .filter(Boolean)
  .map((band) => {
    const indexBand = indexById.get(band.id);
    return {
      id: band.id,
      mbid: band.mbid,
      name: band.name,
      countryCode: band.countryCode,
      aliases: unique(indexBand?.aliases ?? []),
      albums: unique((band.albums ?? []).map((album) => album?.title ?? album)),
      tracks: unique((band.tracks ?? []).map((track) => track?.title ?? track)),
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id, 'en'));

const artists = structuredClone(current.artists ?? {});
const evidence = structuredClone(current.evidence ?? {});
for (const id of Object.keys(artists)) {
  evidence[id] ??= {};
  for (const platform of Object.keys(artists[id])) evidence[id][platform] ??= 'manual';
}

async function saveCache() {
  cache.updatedAt = new Date().toISOString();
  await writeFile(cacheFile, JSON.stringify(cache, null, 2) + '\n');
}

function setLink(id, platform, url, source) {
  if (!url || artists[id]?.[platform]) return false;
  artists[id] ??= {};
  evidence[id] ??= {};
  artists[id][platform] = url;
  evidence[id][platform] = source;
  return true;
}

function urlsFromIds(ids) {
  const out = {};
  if (ids.qq) {
    out.qq =
      'https://i.y.qq.com/n2/m/share/details/singer.html?' +
      `ADTAG=newyqq.singer&singermid=${ids.qq}`;
  }
  if (ids.netease) {
    // 网易旧的 /m/applink 中转页会降级到 HTTP，部分浏览器直接落到 404。
    // 官方移动分享地址可尝试唤起 App，并能在未安装客户端时回落到歌手网页。
    out.netease = `https://y.music.163.com/m/artist?id=${ids.netease}`;
  }
  if (ids.apple) out.apple = `https://music.apple.com/us/artist/band-atlas/${ids.apple}`;
  if (ids.spotify) out.spotify = `https://open.spotify.com/artist/${ids.spotify}`;
  return out;
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(20_000),
        headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) },
      });
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastError;
}

async function fetchJSON(url, options) {
  return (await fetchWithRetry(url, options)).json();
}

function applyIds(id, ids, source) {
  const urls = urlsFromIds(ids);
  for (const [platform, url] of Object.entries(urls)) setLink(id, platform, url, source);
}

async function fetchWikidata() {
  if (cache.wikidataDone) {
    for (const band of bands) applyIds(band.id, cache.wikidata[band.mbid] ?? {}, 'wikidata');
    console.log('✓ Wikidata：使用已有缓存');
    return;
  }
  const withMbid = bands.filter((band) => band.mbid);
  const batchSize = 70;
  for (let offset = 0; offset < withMbid.length; offset += batchSize) {
    const batch = withMbid.slice(offset, offset + batchSize);
    const values = batch.map((band) => JSON.stringify(band.mbid)).join(' ');
    const query = `
      SELECT ?mbid ?spotify ?apple ?netease ?qq WHERE {
        VALUES ?mbid { ${values} }
        ?item wdt:P434 ?mbid.
        OPTIONAL { ?item wdt:P1902 ?spotify. }
        OPTIONAL { ?item wdt:P2850 ?apple. }
        OPTIONAL { ?item wdt:P10445 ?netease. }
        OPTIONAL { ?item wdt:P10410 ?qq. }
      }
    `;
    const url = new URL('https://query.wikidata.org/sparql');
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    const data = await fetchJSON(url);
    for (const row of data.results.bindings) {
      const mbid = row.mbid.value;
      const ids = cache.wikidata[mbid] ?? {};
      for (const key of PLATFORMS) if (row[key]?.value) ids[key] = row[key].value;
      cache.wikidata[mbid] = ids;
    }
    for (const band of batch) applyIds(band.id, cache.wikidata[band.mbid] ?? {}, 'wikidata');
    await saveCache();
    console.log(`  Wikidata ${Math.min(offset + batchSize, withMbid.length)}/${withMbid.length}`);
    await sleep(250);
  }
  cache.wikidataDone = true;
  await saveCache();
  console.log('✓ Wikidata 完成');
}

function parseMusicBrainzRelations(data) {
  const ids = {};
  for (const relation of data.relations ?? []) {
    const resource = relation.url?.resource ?? '';
    let match = resource.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/);
    if (match) ids.spotify = match[1];
    match = resource.match(/music\.apple\.com\/[a-z]{2}\/artist\/(?:[^/]+\/)?(\d+)/);
    if (match) ids.apple = match[1];
    match = resource.match(/(?:y\.qq\.com\/n\/(?:ryqq\/singer|yqq\/singer)\/|singermid=)([A-Za-z0-9]+)/);
    if (match) ids.qq = match[1];
    match = resource.match(/music\.163\.com\/(?:#\/)?artist\?id=(\d+)/);
    if (match) ids.netease = match[1];
  }
  return ids;
}

async function fetchMusicBrainz() {
  if (SKIP_MUSICBRAINZ) return console.log('– 已跳过 MusicBrainz URL relationships');
  const targets = bands.filter(
    (band) =>
      band.mbid &&
      (!artists[band.id]?.spotify || !artists[band.id]?.apple)
  );
  let requested = 0;
  for (const band of targets) {
    if (!(band.mbid in cache.musicbrainz)) {
      const requestStartedAt = Date.now();
      const url =
        `https://musicbrainz.org/ws/2/artist/${band.mbid}` +
        '?inc=url-rels&fmt=json';
      try {
        const data = await fetchJSON(url);
        cache.musicbrainz[band.mbid] = parseMusicBrainzRelations(data);
      } catch (error) {
        cache.musicbrainz[band.mbid] = { error: String(error) };
      }
      requested += 1;
      if (requested % 10 === 0) {
        await saveCache();
        console.log(`  MusicBrainz 新请求 ${requested} · 处理 ${targets.indexOf(band) + 1}/${targets.length}`);
      }
      // MusicBrainz 公共 API 要求平均不超过每秒一次请求。
      await sleep(Math.max(0, 1100 - (Date.now() - requestStartedAt)));
    }
    applyIds(band.id, cache.musicbrainz[band.mbid] ?? {}, 'musicbrainz');
  }
  await saveCache();
  console.log(`✓ MusicBrainz 完成 · 新请求 ${requested}`);
}

function knownNames(band) {
  return unique([band.name, ...band.aliases]).map(norm).filter(Boolean);
}

function isStrongExactName(band, candidateName) {
  const candidate = norm(candidateName);
  if (!candidate) return false;
  if (candidate === norm(band.name)) return true;
  // 很短的别名通常是缩写（ABC、T、D 等），跨平台同名率太高，
  // 只能作为人工审核线索，不能自动认领艺人主页。
  return band.aliases.some((alias) => {
    const normalized = norm(alias);
    return normalized.length >= 5 && candidate === normalized;
  });
}

function exactCandidate(band, candidates) {
  const exact = candidates.filter((candidate) => isStrongExactName(band, candidate.name));
  if (!exact.length) return null;
  exact.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  return exact[0];
}

async function searchQQ(band, query) {
  const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp');
  url.searchParams.set('p', '1');
  url.searchParams.set('n', '20');
  url.searchParams.set('w', query);
  url.searchParams.set('format', 'json');
  const data = await fetchJSON(url);
  const byId = new Map();
  for (const song of data.data?.song?.list ?? []) {
    for (const singer of song.singer ?? []) {
      const item = byId.get(singer.mid) ?? { id: singer.mid, name: singer.name, weight: 0 };
      item.weight += 1;
      byId.set(singer.mid, item);
    }
  }
  return [...byId.values()];
}

async function searchNetease(band, query) {
  const body = new URLSearchParams({ s: query, type: '100', limit: '10', offset: '0' });
  const data = await fetchJSON('https://music.163.com/api/search/get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return (data.result?.artists ?? []).map((artist) => ({
    id: String(artist.id),
    name: artist.name,
    weight: artist.albumSize ?? 0,
  }));
}

async function searchApple(band, query) {
  const country = {
    CN: 'cn', TW: 'tw', HK: 'hk', JP: 'jp', KR: 'kr',
  }[band.countryCode] ?? 'us';
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', query);
  url.searchParams.set('entity', 'musicArtist');
  url.searchParams.set('country', country);
  url.searchParams.set('limit', '10');
  const data = await fetchJSON(url);
  return (data.results ?? []).map((artist, index) => ({
    id: String(artist.artistId),
    name: artist.artistName,
    weight: 20 - index,
    url: artist.artistLinkUrl?.replace(/\?uo=\d+$/, ''),
  }));
}

const searchers = { qq: searchQQ, netease: searchNetease, apple: searchApple };

async function searchOne(platform, band) {
  const cached = cache.searches[platform][band.id];
  if (cached?.done) return cached;
  const queries = unique([band.name, ...band.aliases]).slice(0, 4);
  const allCandidates = [];
  let error = null;
  for (const query of queries) {
    try {
      const candidates = await searchers[platform](band, query);
      allCandidates.push(...candidates);
      const exact = exactCandidate(band, allCandidates);
      if (exact) {
        const result = { done: true, exact, candidates: allCandidates.slice(0, 10) };
        cache.searches[platform][band.id] = result;
        return result;
      }
    } catch (caught) {
      error = String(caught);
      await sleep(500);
    }
  }
  const result = { done: true, exact: null, candidates: allCandidates.slice(0, 10), error };
  cache.searches[platform][band.id] = result;
  return result;
}

async function mapConcurrent(items, worker, concurrency) {
  let cursor = 0;
  let completed = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
      completed += 1;
      if (completed % 25 === 0 || completed === items.length) {
        await saveCache();
        console.log(`  搜索 ${completed}/${items.length}`);
      }
      await sleep(120);
    }
  });
  await Promise.all(runners);
}

async function searchMissing(platform) {
  const targets = bands.filter((band) => !artists[band.id]?.[platform]);
  console.log(`开始 ${platform} 精确名称搜索：${targets.length} 支`);
  await mapConcurrent(
    targets,
    async (band) => {
      const result = await searchOne(platform, band);
      if (!result.exact) return;
      const url = platform === 'qq'
        ? urlsFromIds({ qq: result.exact.id }).qq
        : platform === 'netease'
          ? urlsFromIds({ netease: result.exact.id }).netease
          : result.exact.url ?? urlsFromIds({ apple: result.exact.id }).apple;
      setLink(band.id, platform, url, 'search-exact');
    },
    SEARCH_CONCURRENCY
  );
  await saveCache();
}

function titleVariants(title) {
  const full = norm(title);
  const withoutEdition = norm(
    String(title ?? '').replace(/\s*[\(\[（【][^(\[（【]*[\)\]）】]\s*$/u, '')
  );
  return unique([full, withoutEdition]).filter((value) => value.length >= 2);
}

function titleSet(titles) {
  return new Set(titles.flatMap(titleVariants));
}

async function fetchCandidateCatalog(platform, id) {
  const cached = cache.catalogs[platform][id];
  if (cached?.done) return cached;
  try {
    let tracks = [];
    let albums = [];
    if (platform === 'qq') {
      const payload = {
        comm: { ct: 24, cv: 0 },
        singerSongList: {
          method: 'GetSingerSongList',
          param: { order: 1, singerMid: id, begin: 0, num: 50 },
          module: 'musichall.song_list_server',
        },
      };
      const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');
      url.searchParams.set('data', JSON.stringify(payload));
      const data = await fetchJSON(url);
      const songs = data.singerSongList?.data?.songList ?? [];
      tracks = songs.map((item) => item.songInfo?.title);
      albums = songs.map((item) => item.songInfo?.album?.name);
    } else if (platform === 'netease') {
      const data = await fetchJSON(`https://music.163.com/api/artist/${id}`);
      tracks = (data.hotSongs ?? []).map((song) => song.name);
      albums = (data.hotSongs ?? []).map((song) => song.album?.name);
    } else {
      const base = new URL('https://itunes.apple.com/lookup');
      base.searchParams.set('id', id);
      base.searchParams.set('entity', 'song');
      base.searchParams.set('limit', '50');
      const songs = await fetchJSON(base);
      tracks = (songs.results ?? []).map((item) => item.trackName);
      albums = (songs.results ?? []).map((item) => item.collectionName);

      const albumUrl = new URL(base);
      albumUrl.searchParams.set('entity', 'album');
      const albumResults = await fetchJSON(albumUrl);
      albums.push(...(albumResults.results ?? []).map((item) => item.collectionName));
    }
    const result = { done: true, tracks: unique(tracks), albums: unique(albums) };
    cache.catalogs[platform][id] = result;
    return result;
  } catch (error) {
    const result = { done: true, tracks: [], albums: [], error: String(error) };
    cache.catalogs[platform][id] = result;
    return result;
  }
}

function scoreCatalog(band, catalog) {
  const knownTracks = titleSet(band.tracks);
  const knownAlbums = titleSet(band.albums);
  const candidateTracks = titleSet(catalog.tracks ?? []);
  const candidateAlbums = titleSet(catalog.albums ?? []);
  const matchedTracks = [...knownTracks].filter((title) => candidateTracks.has(title));
  const matchedAlbums = [...knownAlbums].filter((title) => candidateAlbums.has(title));
  return {
    score: matchedTracks.length * 2 + matchedAlbums.length * 3,
    matchedTracks,
    matchedAlbums,
  };
}

function candidateUrl(platform, candidate) {
  if (platform === 'qq') return urlsFromIds({ qq: candidate.id }).qq;
  if (platform === 'netease') return urlsFromIds({ netease: candidate.id }).netease;
  return candidate.url ?? urlsFromIds({ apple: candidate.id }).apple;
}

async function resolveAmbiguousMatches() {
  const jobs = [];
  for (const platform of ['qq', 'netease', 'apple']) {
    for (const band of bands) {
      const existingSource = evidence[band.id]?.[platform];
      if (
        artists[band.id]?.[platform] &&
        !['search-exact', 'search-works'].includes(existingSource)
      ) continue;
      if (!band.tracks.length && !band.albums.length) continue;
      const search = cache.searches[platform]?.[band.id];
      const candidates = [
        ...new Map(
          [search?.exact, ...(search?.candidates ?? [])]
            .filter((candidate) => candidate && isStrongExactName(band, candidate.name))
            .map((candidate) => [candidate.id, candidate])
        ).values(),
      ];
      if (candidates.length > 1) jobs.push({ platform, band, candidates });
    }
  }

  console.log(`开始用作品信息核对同名候选：${jobs.length} 组`);
  let recovered = 0;
  await mapConcurrent(
    jobs,
    async ({ platform, band, candidates }) => {
      const scored = [];
      for (const candidate of candidates) {
        const catalog = await fetchCandidateCatalog(platform, candidate.id);
        scored.push({ candidate, ...scoreCatalog(band, catalog) });
      }
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      const runnerUp = scored[1];
      const hasDistinctiveTrack =
        best?.matchedTracks.some((title) => title.length >= 8) ?? false;
      const accepted =
        best &&
        (best.score >= 3 || hasDistinctiveTrack) &&
        best.score !== runnerUp?.score;
      if (!accepted) {
        if (['search-exact', 'search-works'].includes(evidence[band.id]?.[platform])) {
          delete artists[band.id]?.[platform];
          delete evidence[band.id]?.[platform];
        }
        delete cache.searches[platform][band.id].resolvedByWorks;
        return;
      }
      artists[band.id] ??= {};
      evidence[band.id] ??= {};
      artists[band.id][platform] = candidateUrl(platform, best.candidate);
      evidence[band.id][platform] = 'search-works';
      recovered += 1;
      cache.searches[platform][band.id].resolvedByWorks = {
        id: best.candidate.id,
        score: best.score,
        matchedTracks: best.matchedTracks,
        matchedAlbums: best.matchedAlbums,
      };
    },
    Math.min(SEARCH_CONCURRENCY, 6)
  );
  await saveCache();
  console.log(`✓ 作品核对完成 · 恢复 ${recovered} 个主页`);
}

function buildReview() {
  const review = [];
  for (const band of bands) {
    for (const platform of PLATFORMS) {
      if (artists[band.id]?.[platform]) continue;
      const search = cache.searches?.[platform]?.[band.id];
      review.push({
        bandId: band.id,
        name: band.name,
        platform,
        status: search?.candidates?.length ? 'needs-review' : 'not-found',
        candidates: (search?.candidates ?? []).slice(0, 5),
      });
    }
  }
  return review;
}

function coverage() {
  const counts = Object.fromEntries(PLATFORMS.map((platform) => [platform, 0]));
  let any = 0;
  let all = 0;
  for (const band of bands) {
    const present = PLATFORMS.filter((platform) => artists[band.id]?.[platform]);
    for (const platform of present) counts[platform] += 1;
    if (present.length) any += 1;
    if (present.length === PLATFORMS.length) all += 1;
  }
  return { total: bands.length, any, all, ...counts };
}

function sanitizeSearchMatches() {
  const byId = new Map(bands.map((band) => [band.id, band]));
  let weakRemoved = 0;
  let ambiguousRemoved = 0;
  let duplicateRemoved = 0;

  for (const [id, sources] of Object.entries(evidence)) {
    const band = byId.get(id);
    if (!band) continue;
    for (const [platform, source] of Object.entries(sources)) {
      if (source !== 'search-exact') continue;
      const search = cache.searches?.[platform]?.[id];
      const exact = search?.exact;
      const matchingIds = new Set(
        [exact, ...(search?.candidates ?? [])]
          .filter((candidate) => candidate && isStrongExactName(band, candidate.name))
          .map((candidate) => candidate.id)
      );
      if (exact && isStrongExactName(band, exact.name) && matchingIds.size === 1) continue;
      delete artists[id]?.[platform];
      delete evidence[id]?.[platform];
      if (matchingIds.size > 1) ambiguousRemoved += 1;
      else weakRemoved += 1;
    }
  }

  const priority = {
    manual: 5,
    wikidata: 4,
    musicbrainz: 3,
    'search-works': 2,
    'search-exact': 1,
  };
  for (const platform of PLATFORMS) {
    const owners = new Map();
    for (const [id, links] of Object.entries(artists)) {
      const url = links[platform];
      if (!url) continue;
      const ids = owners.get(url) ?? [];
      ids.push(id);
      owners.set(url, ids);
    }
    for (const ids of owners.values()) {
      if (ids.length < 2) continue;
      const authoritative = ids
        .filter((id) => (priority[evidence[id]?.[platform]] ?? 0) >= 2)
        .sort((a, b) =>
          (priority[evidence[b]?.[platform]] ?? 0) -
          (priority[evidence[a]?.[platform]] ?? 0)
        );
      const keep = authoritative[0] ?? null;
      for (const id of ids) {
        if (id === keep) continue;
        delete artists[id]?.[platform];
        delete evidence[id]?.[platform];
        duplicateRemoved += 1;
      }
    }
  }

  for (const id of Object.keys(artists)) {
    if (!Object.keys(artists[id]).length) delete artists[id];
    if (!Object.keys(evidence[id] ?? {}).length) delete evidence[id];
  }
  console.log(
    `✓ 自动匹配清洗 · 弱别名移除 ${weakRemoved} · ` +
    `同名歧义移除 ${ambiguousRemoved} · 重复 URL 移除 ${duplicateRemoved}`
  );
}

await fetchWikidata();
await fetchMusicBrainz();
for (const platform of ['qq', 'netease', 'apple']) await searchMissing(platform);
await resolveAmbiguousMatches();
sanitizeSearchMatches();

const sortedArtists = Object.fromEntries(
  Object.keys(artists).sort((a, b) => a.localeCompare(b, 'en')).map((id) => [id, artists[id]])
);
const sortedEvidence = Object.fromEntries(
  Object.keys(evidence).sort((a, b) => a.localeCompare(b, 'en')).map((id) => [id, evidence[id]])
);
const output = {
  note:
    '流媒体艺人主页：人工核对与权威外部 ID 优先，平台搜索只接受名称或正式别名精确匹配。',
  generatedAt: new Date().toISOString(),
  coverage: coverage(),
  artists: sortedArtists,
  evidence: sortedEvidence,
  review: buildReview(),
};
await writeFile(outputFile, JSON.stringify(output, null, 2) + '\n');
await saveCache();
console.log('✓ 已写入 data/source/music-links.json');
console.log(JSON.stringify(output.coverage, null, 2));
