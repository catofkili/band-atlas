#!/usr/bin/env node
/**
 * 从人工列出的日本当代热门候选出发，解析 MusicBrainz 艺人、官方别名、
 * 专辑/EP 与 ListenBrainz 热度，并生成推荐边。允许 Group 与 Person。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  useCache,
  getJSON,
  mbArtist,
  mbSearchArtist,
  mbReleaseGroups,
  mbReleaseGroupsOfType,
  stats,
} from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/modern-japan'));

const readJSON = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(path.join(root, file), 'utf8'));
  } catch {
    return fallback;
  }
};
const seedSource = await readJSON('data/source/modern-japan-seeds.json', { seeds: [] });
const generated = await readJSON('data/source/generated.json', { bands: [] });
const curated = await readJSON('data/source/scene-jrock.json', { bands: [] });
const popularity = await readJSON('data/source/popularity.json', { artists: {}, failures: [] });
const previousModern = await readJSON('data/source/modern-japan.json', { bands: [] });

const existingBands = [...generated.bands, ...curated.bands];
const existingByMbid = new Map(existingBands.filter((band) => band.mbid).map((band) => [band.mbid, band]));
const previousByMbid = new Map(
  (previousModern.bands ?? []).filter((band) => band.mbid).map((band) => [band.mbid, band])
);
const occupiedIds = new Set(existingBands.map((band) => band.id));
const VERIFIED_MBIDS = new Map([
  ['natori', 'cad9e169-893d-4432-a23f-3aa16beb9f0e'],
  ['BE:FIRST', 'c11b6e14-9a78-40c3-b70c-c46e8b819637'],
]);

const norm = (text) =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase('ja')
    .replace(/[\s・･._'’\-–—]+/g, '');
const hash = (text) => {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
};
const countryCodeOf = (artist) =>
  artist.country ?? artist.area?.['iso-3166-1-codes']?.[0] ?? null;
const slugify = (name, mbid) => {
  const base =
    name
      .toLocaleLowerCase('ja')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `artist-${mbid.slice(0, 6)}`;
  let id = base;
  if (occupiedIds.has(id)) id = `${base}-${mbid.slice(0, 6)}`;
  occupiedIds.add(id);
  return id;
};
const yearsOf = (artist) => {
  const begin = (artist['life-span']?.begin ?? '').slice(0, 4);
  const end = (artist['life-span']?.end ?? '').slice(0, 4);
  return begin ? (end ? `${begin}–${end}` : `${begin}–`) : null;
};
const GENRES_ZH = new Map([
  ['j-pop', '日本流行音乐'],
  ['japanese pop', '日本流行音乐'],
  ['pop', '流行音乐'],
  ['pop rock', '流行摇滚'],
  ['rock', '摇滚'],
  ['alternative rock', '另类摇滚'],
  ['indie rock', '独立摇滚'],
  ['indie pop', '独立流行'],
  ['hip hop', '嘻哈'],
  ['japanese hip hop', '日本嘻哈'],
  ['electropop', '电子流行'],
  ['electronic', '电子音乐'],
  ['dance-pop', '流行舞曲'],
  ['r&b', '节奏布鲁斯'],
  ['contemporary r&b', '当代节奏布鲁斯'],
  ['singer-songwriter', '唱作人'],
  ['vocaloid', 'Vocaloid'],
  ['city pop', '城市流行'],
  ['idol', '偶像流行'],
  ['kawaii metal', '可爱金属'],
  ['heavy metal', '重金属'],
]);
const genreNames = (artist) => {
  const tags = [...(artist.tags ?? [])]
    .filter((tag) => (tag.count ?? 0) >= 1)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return [
    ...new Set(
      tags
        .map((tag) => GENRES_ZH.get(tag.name.toLowerCase()))
        .filter(Boolean)
    ),
  ].slice(0, 5);
};
const worksFrom = (groups, kind) =>
  groups
    .filter((group) => !(group['secondary-types'] ?? []).length)
    .map((group) => ({
      title: group.title,
      year: Number((group['first-release-date'] ?? '').slice(0, 4)) || null,
      kind,
    }))
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title, 'ja'))
    .slice(0, 6);

const resolved = [];
for (const [index, seedName] of seedSource.seeds.entries()) {
  const verifiedMbid = VERIFIED_MBIDS.get(seedName);
  const search = verifiedMbid ? null : await mbSearchArtist(seedName);
  const candidates = [...(search?.artists ?? [])]
    .filter((artist) => artist.type === 'Group' || artist.type === 'Person')
    .sort((a, b) => {
      const aExact = norm(a.name) === norm(seedName) || (a.aliases ?? []).some((alias) => norm(alias.name) === norm(seedName));
      const bExact = norm(b.name) === norm(seedName) || (b.aliases ?? []).some((alias) => norm(alias.name) === norm(seedName));
      return Number(bExact) - Number(aExact) || (b.score ?? 0) - (a.score ?? 0);
    });
  const rough = verifiedMbid
    ? { id: verifiedMbid }
    :
    candidates.find((artist) => countryCodeOf(artist) === 'JP') ??
    candidates[0];
  if (!rough) {
    console.warn(`  跳过：MusicBrainz 找不到 ${seedName}`);
    continue;
  }
  const artist = await mbArtist(rough.id);
  if (
    !artist ||
    (!VERIFIED_MBIDS.has(seedName) && countryCodeOf(artist) !== 'JP') ||
    !['Group', 'Person'].includes(artist.type)
  ) {
    console.warn(`  跳过：${seedName} 不是日本 Group/Person`);
    continue;
  }

  const albumData = await mbReleaseGroups(artist.id);
  let works = worksFrom(albumData?.['release-groups'] ?? [], 'Album');
  if (!works.length) {
    const epData = await mbReleaseGroupsOfType(artist.id, 'ep');
    works = worksFrom(epData?.['release-groups'] ?? [], 'EP');
  }
  const listenData = await getJSON(
    `https://api.listenbrainz.org/1/stats/artist/${artist.id}/listeners?range=all_time`
  );
  const listens = listenData?.payload?.total_listen_count ?? 0;
  const listeners =
    listenData?.payload?.total_user_count ??
    listenData?.payload?.listeners?.length ??
    0;
  const aliases = [
    artist['sort-name'],
    ...(artist.aliases ?? []).map((alias) => alias.name),
  ].filter((alias) => alias && norm(alias) !== norm(artist.name));

  resolved.push({
    seedName,
    artist,
    listens,
    listeners,
    aliases: [...new Set(aliases)],
    genres: genreNames(artist),
    works,
  });
  console.log(`  ${index + 1}/${seedSource.seeds.length} ${artist.name} · ${listens} 次收听`);
}

resolved.sort((a, b) => b.listens - a.listens || a.artist.name.localeCompare(b.artist.name, 'ja'));
const allIds = new Map(existingByMbid);
const newBands = [];
for (const item of resolved) {
  const existing = existingByMbid.get(item.artist.id);
  if (existing) {
    allIds.set(item.artist.id, existing);
    continue;
  }
  const id = previousByMbid.get(item.artist.id)?.id ?? slugify(item.artist.name, item.artist.id);
  const kind = item.artist.type === 'Person' ? '音乐人' : '音乐组合';
  const band = {
    id,
    mbid: item.artist.id,
    name: item.artist.name,
    artistType: item.artist.type,
    aliases: item.aliases,
    area: item.artist['begin-area']?.name ?? item.artist.area?.name ?? '日本',
    countryCode: 'JP',
    country: '日本',
    years: yearsOf(item.artist),
    genres: item.genres,
    albums: item.works,
    intro: `${item.artist.name}是来自日本的${kind}。现有资料收录了${item.works.length}张代表专辑或EP。`,
    introLang: 'zh',
    introTemplate: true,
  };
  newBands.push(band);
  allIds.set(item.artist.id, band);
}

const resolvedNodes = resolved
  .map((item) => ({ ...item, id: allIds.get(item.artist.id)?.id }))
  .filter((item) => item.id);
const edges = [];
const seenPairs = new Set();
for (const item of resolvedNodes.filter((node) => newBands.some((band) => band.id === node.id))) {
  const ownGenres = new Set(item.genres);
  const ownPopularity = Math.log10(item.listens + 1);
  const candidates = resolvedNodes
    .filter((candidate) => candidate.id !== item.id)
    .map((candidate) => {
      const sharedGenres = candidate.genres.filter((genre) => ownGenres.has(genre)).length;
      const popularityDistance = Math.abs(Math.log10(candidate.listens + 1) - ownPopularity);
      return {
        candidate,
        score:
          sharedGenres * 8 -
          popularityDistance +
          ((hash(`${item.id}|${candidate.id}`) % 1000) / 1000) * 0.12,
      };
    })
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  for (const { candidate } of candidates.slice(0, 3)) {
    const key = [item.id, candidate.id].sort().join('|');
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    edges.push({
      from: item.id,
      to: candidate.id,
      type: 'scene',
      weight: 0.42,
      label: '当代日本推荐',
      detail: '按 ListenBrainz 热度与 MusicBrainz 流派标签生成的推荐，不表示成员或影响事实。',
    });
  }
}

for (const item of resolved) {
  popularity.artists[item.artist.id] = {
    name: item.artist.name,
    listens: item.listens,
    listeners: item.listeners,
    updatedAt: new Date().toISOString(),
  };
}
popularity.failures = (popularity.failures ?? []).filter(
  (failure) => !resolved.some((item) => item.artist.id === failure.mbid)
);

await writeFile(
  path.join(root, 'data/source/modern-japan.json'),
  JSON.stringify(
    {
      note: '日本当代热门 Group/Person；MusicBrainz 元数据，ListenBrainz 热度排序，推荐边非事实关系。',
      generatedAt: new Date().toISOString(),
      resolved: resolved.map((item, index) => ({
        rank: index + 1,
        seedName: item.seedName,
        name: item.artist.name,
        mbid: item.artist.id,
        artistType: item.artist.type,
        listens: item.listens,
        existing: existingByMbid.has(item.artist.id),
      })),
      bands: newBands,
      edges,
    },
    null,
    2
  ) + '\n'
);
await writeFile(
  path.join(root, 'data/source/popularity.json'),
  JSON.stringify(popularity, null, 2) + '\n'
);
console.log(
  `✓ 解析 ${resolved.length} 位，新增 ${newBands.length} 位，推荐边 ${edges.length}；` +
  `缓存 ${stats().hits}，请求 ${stats().misses}`
);
