#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const [indexHtml, mainJs, mapJs, standalone, indexText, graphText, reviewText] = await Promise.all([
  read('index.html'),
  read('js/main.js'),
  read('js/map.js'),
  read('dist/band-atlas.html'),
  read('data/index.json'),
  read('data/graph.json'),
  read('data/review/history-candidates.json'),
]);
const index = JSON.parse(indexText);
const graph = JSON.parse(graphText);
const review = JSON.parse(reviewText);
const bandFiles = (await readdir(path.join(root, 'data/bands'))).filter((file) => file.endsWith('.json'));
const bands = await Promise.all(
  bandFiles.map(async (file) => JSON.parse(await read(`data/bands/${file}`)))
);

const versions = [
  indexHtml.match(/style\.css\?v=([a-zA-Z0-9._-]+)/)?.[1],
  indexHtml.match(/js\/main\.js\?v=([a-zA-Z0-9._-]+)/)?.[1],
  mainJs.match(/\.\/map\.js\?v=([a-zA-Z0-9._-]+)/)?.[1],
  mapJs.match(/const GRAPH_VERSION = '([^']+)'/)?.[1],
];
if (versions.some((version) => !version) || new Set(versions).size !== 1) {
  throw new Error(`静态资源版本不一致：${versions.join(', ')}`);
}
if (!standalone.includes('BAND_ATLAS_DATA = {"index":') || !standalone.includes('"graph":{"generatedAt"')) {
  throw new Error('单文件版没有嵌入索引与全网地图数据');
}
if (!standalone.includes('createNetworkMap') || !standalone.includes('map-band-select')) {
  throw new Error('单文件版缺少地图代码或地图入口');
}
if (!standalone.includes('map-popular-toggle') || !standalone.includes('POPULAR_LISTEN_FLOOR')) {
  throw new Error('单文件版缺少地图热度筛选');
}
if (
  !/id="popular-toggle"[\s\S]{0,180}aria-pressed="true"/.test(indexHtml) ||
  !mainJs.includes("stored == null ? true") ||
  !mainJs.includes("band.edges.filter((edge) => isPopularBand(edge.to))") ||
  !mainJs.includes("band.id !== exclude && (!popularOnly || isPopularBand(band.id))") ||
  !mapJs.includes("initialPopularOnly = true")
) {
  throw new Error('主页面“隐藏冷门”没有默认开启或没有覆盖关系与随机入口');
}

const randomPool = index.bands.filter(
  (band) =>
    band.degree >= 3 &&
    !band.quality?.templateIntro &&
    (band.quality?.score ?? 0) >= 38
);
if (randomPool.length < 40) throw new Error(`高质量随机池过小：${randomPool.length}`);
if (randomPool.some((band) => band.degree < 3 || band.quality?.templateIntro)) {
  throw new Error('高质量随机池混入模板卡或死胡同');
}
const withPopularity = index.bands.filter((band) => Number.isFinite(band.listens)).length;
if (withPopularity !== index.bands.length) {
  throw new Error(`热度字段缺失：${withPopularity}/${index.bands.length}`);
}
const popularBands = index.bands.filter((band) => band.listens >= 1000);
if (popularBands.length < 450 || popularBands.length >= index.bands.length) {
  throw new Error(`默认冷门筛选范围异常：${popularBands.length}/${index.bands.length}`);
}
const compactSearch = (text) =>
  (text ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ja')
    .replace(/[\s・･._'’\-–—]+/g, '');
const katakanaToHiragana = (text) =>
  [...text].map((char) => {
    const code = char.codePointAt(0);
    return code >= 0x30a1 && code <= 0x30f6
      ? String.fromCodePoint(code - 0x60)
      : char;
  }).join('');
const exactSearch = (query) => {
  const q = compactSearch(query);
  const qKana = katakanaToHiragana(q);
  return index.bands.filter((band) =>
    (band.searchKeys ?? []).flatMap((key) => [key, katakanaToHiragana(key)])
      .some((key) => key === q || key === qKana)
  );
};
for (const [query, expected] of [
  ['YOASOBI', 'YOASOBI'],
  ['ヨアソビ', 'YOASOBI'],
  ['よあそび', 'YOASOBI'],
  ['Fujii Kaze', '藤井風'],
  ['フジイカゼ', '藤井風'],
  ['ふじいかぜ', '藤井風'],
  ['Hikaru Utada', '宇多田ヒカル'],
  ['宇多田光', '宇多田ヒカル'],
  ['Hoshimachi Suisei', '星街すいせい'],
  ['GReeeeN', 'GRe4N BOYZ'],
  ['Ikimonogakari', 'いきものがかり'],
]) {
  if (!exactSearch(query).some((band) => band.name === expected)) {
    throw new Error(`全局多文字搜索失效：${query} → ${expected}`);
  }
}
const people = index.bands.filter((band) => band.artistType === 'Person');
if (people.length < 25) throw new Error(`个人音乐人异常减少：${people.length}`);
for (const name of [
  'YOASOBI', 'Vaundy', '藤井風', 'Ado', 'なとり', 'BE:FIRST',
  'Aimer', 'HANA', 'XG', '星街すいせい', '櫻坂46', '乃木坂46', 'いきものがかり',
]) {
  if (!index.bands.some((band) => band.name === name)) {
    throw new Error(`当代日本名单缺少：${name}`);
  }
}
for (const name of ['Aimer', 'HANA', 'XG', '星街すいせい', '櫻坂46', '乃木坂46']) {
  const band = index.bands.find((item) => item.name === name);
  if ((band?.listens ?? 0) < 1000) {
    throw new Error(`热门增量会被默认冷门筛选隐藏：${name}`);
  }
}
const usWithoutAlbums = bands.filter(
  (band) => band.countryCode === 'US' && !(band.albums?.length)
);
if (usWithoutAlbums.length) {
  throw new Error(`美国完整专辑准入回退：${usWithoutAlbums.length} 支没有完整专辑`);
}
if (bands.length < 900) {
  throw new Error(`推歌节点异常减少：${bands.length}`);
}
const regions = Object.groupBy(index.bands, (band) => band.region);
if ((regions.unknown?.length ?? 0) > 80) {
  throw new Error(`地区未知节点回升：${regions.unknown.length}`);
}
if ((regions['east-asia']?.length ?? 0) < 340) {
  throw new Error(`东亚节点异常减少：${regions['east-asia']?.length ?? 0}`);
}
if (bands.some((band) => band.introLang !== 'zh')) {
  throw new Error('仍有简介没有标记为中文');
}
const guestEdges = graph.edges.filter((edge) => edge.type === 'guest').length;
if (guestEdges < 50) throw new Error(`客串关系异常减少：${guestEdges}`);
const reviewCandidates = review.candidates ?? [];
if (
  reviewCandidates.length < 10 ||
  reviewCandidates.filter((candidate) => candidate.region === 'east-asia').length < 8
) {
  throw new Error('恩怨情仇审核包缺失或东亚候选过少');
}
const approvedCandidates = reviewCandidates.filter((candidate) => candidate.status === 'approved');
for (const candidate of approvedCandidates) {
  const band = bands.find((item) => item.id === candidate.bandId);
  if (!band?.lore?.includes(candidate.proposedLore)) {
    throw new Error(`已批准轶事没有进入乐队卡片：${candidate.id}`);
  }
  if (
    candidate.source &&
    !band.loreSources?.some((source) => source.url === candidate.source)
  ) {
    throw new Error(`已批准轶事缺少来源链接：${candidate.id}`);
  }
  if (
    candidate.proposedEdge &&
    !band.edges?.some(
      (edge) =>
        edge.to === candidate.proposedEdge.to &&
        edge.type === candidate.proposedEdge.type
    )
  ) {
    throw new Error(`已批准关系没有进入关系图：${candidate.id}`);
  }
}

const content = {
  template: bands.filter((band) => band.quality?.templateIntro).length,
  genres: bands.filter((band) => band.genres?.length).length,
  tracks: bands.filter((band) => band.tracks?.length).length,
  lore: bands.filter((band) => band.lore).length,
  degreeOne: bands.filter((band) => band.edges?.length === 1).length,
};
if (content.genres < 580 || content.tracks < 260) {
  throw new Error(`内容补全回退：流派 ${content.genres} / 代表曲 ${content.tracks}`);
}
console.log(
  `✓ 站点回归通过 · 资源 ${versions[0]} · 随机池 ${randomPool.length} · ` +
  `默认可见 ${popularBands.length}/${bands.length} · 个人音乐人 ${people.length} · 客串 ${guestEdges}`
);
console.log(
  `  内容：模板 ${content.template}，有流派 ${content.genres}，` +
  `有代表曲 ${content.tracks}，有轶事 ${content.lore}（本次批准 ${approvedCandidates.length}），` +
  `单关系 ${content.degreeOne}；` +
  `地区：东亚 ${regions['east-asia']?.length ?? 0}，未知 ${regions.unknown?.length ?? 0}`
);
