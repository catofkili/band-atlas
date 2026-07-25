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
if (content.genres < 600 || content.tracks < 250) {
  throw new Error(`内容补全回退：流派 ${content.genres} / 代表曲 ${content.tracks}`);
}
console.log(
  `✓ 站点回归通过 · 资源 ${versions[0]} · 随机池 ${randomPool.length} · ` +
  `热度 ${withPopularity}/${bands.length} · 客串 ${guestEdges}`
);
console.log(
  `  内容：模板 ${content.template}，有流派 ${content.genres}，` +
  `有代表曲 ${content.tracks}，有轶事 ${content.lore}（本次批准 ${approvedCandidates.length}），` +
  `单关系 ${content.degreeOne}；` +
  `地区：东亚 ${regions['east-asia']?.length ?? 0}，未知 ${regions.unknown?.length ?? 0}`
);
