#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  RANDOM_REGION_SHARES,
  bellPopularityWeight,
  chooseRandomBand,
} from '../js/random.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const [
  indexHtml,
  styleText,
  mainJs,
  mapJs,
  renderJs,
  standalone,
  indexText,
  graphText,
  reviewText,
  greaterChinaText,
  musicLinksText,
] = await Promise.all([
  read('index.html'),
  read('style.css'),
  read('js/main.js'),
  read('js/map.js'),
  read('js/render.js'),
  read('dist/band-atlas.html'),
  read('data/index.json'),
  read('data/graph.json'),
  read('data/review/history-candidates.json'),
  read('data/source/greater-china.json'),
  read('data/source/music-links.json'),
]);
const index = JSON.parse(indexText);
const graph = JSON.parse(graphText);
const review = JSON.parse(reviewText);
const greaterChina = JSON.parse(greaterChinaText);
const musicLinks = JSON.parse(musicLinksText);
const bandFiles = (await readdir(path.join(root, 'data/bands'))).filter((file) => file.endsWith('.json'));
const bands = await Promise.all(
  bandFiles.map(async (file) => JSON.parse(await read(`data/bands/${file}`)))
);

const musicLinkPatterns = {
  qq: /^https:\/\/i\.y\.qq\.com\/n2\/m\/share\/details\/singer\.html\?ADTAG=newyqq\.singer&singermid=[A-Za-z0-9]+$/,
  netease: /^https:\/\/y\.music\.163\.com\/m\/artist\?id=\d+$/,
  apple: /^https:\/\/music\.apple\.com\/cn\/artist\/(?!band-atlas\/|id-\d+\/)[^/]+\/\d+$/,
  spotify: /^https:\/\/open\.spotify\.com\/artist\/[A-Za-z0-9]+$/,
};
const verifiedMusicArtists = Object.entries(musicLinks.artists ?? {});
if (musicLinks.coverage?.total !== bands.length || verifiedMusicArtists.length < 800) {
  throw new Error(
    `流媒体主页没有覆盖全量数据集：组件目标 ${bands.length}，有链接 ${verifiedMusicArtists.length}`
  );
}
const computedCoverage = {
  total: bands.length,
  any: 0,
  all: 0,
  qq: 0,
  netease: 0,
  apple: 0,
  spotify: 0,
};
const ownedUrls = new Map();
for (const [id, links] of verifiedMusicArtists) {
  const band = bands.find((item) => item.id === id);
  if (!band) throw new Error(`流媒体链接没有对应乐队：${id}`);
  if (!Object.keys(links).length) throw new Error(`流媒体链接为空：${id}`);
  computedCoverage.any += 1;
  if (Object.keys(musicLinkPatterns).every((platform) => links[platform])) {
    computedCoverage.all += 1;
  }
  for (const [platform, url] of Object.entries(links)) {
    if (!musicLinkPatterns[platform]?.test(url)) {
      throw new Error(`流媒体艺人主页格式错误：${id}.${platform}`);
    }
    if (!musicLinks.evidence?.[id]?.[platform]) {
      throw new Error(`流媒体艺人主页缺少证据类型：${id}.${platform}`);
    }
    if (band.musicLinks?.[platform] !== url) {
      throw new Error(`流媒体艺人主页没有进入卡片数据：${id}.${platform}`);
    }
    computedCoverage[platform] += 1;
    const ownershipKey = `${platform}:${url}`;
    if (ownedUrls.has(ownershipKey)) {
      throw new Error(
        `两个乐队错误共用同一主页：${ownedUrls.get(ownershipKey)} / ${id} (${platform})`
      );
    }
    ownedUrls.set(ownershipKey, id);
  }
}
if (JSON.stringify(computedCoverage) !== JSON.stringify(musicLinks.coverage)) {
  throw new Error(
    `流媒体覆盖统计与实际链接不一致：${JSON.stringify(computedCoverage)}`
  );
}
const reviewKeys = new Set(
  (musicLinks.review ?? []).map((item) => `${item.bandId}:${item.platform}`)
);
for (const band of bands) {
  if (!band.musicLinks || typeof band.musicLinks !== 'object') {
    throw new Error(`卡片缺少 musicLinks 数据槽：${band.id}`);
  }
  for (const platform of Object.keys(musicLinkPatterns)) {
    const key = `${band.id}:${platform}`;
    const hasLink = Boolean(musicLinks.artists?.[band.id]?.[platform]);
    if (hasLink === reviewKeys.has(key)) {
      throw new Error(`流媒体待复核清单与链接状态冲突：${key}`);
    }
  }
}
const completeFirstBatch = [
  'radwimps',
  'x-japan',
  'babymetal',
  'yoasobi',
  'mrs-green-apple',
  'l-arc-en-ciel',
  'フィッシュマンズ',
  'beyond',
  'omnipotent-youth-society',
  'no-party-for-cao-dong',
];
for (const id of completeFirstBatch) {
  for (const platform of Object.keys(musicLinkPatterns)) {
    if (!musicLinks.artists?.[id]?.[platform]) {
      throw new Error(`首批流媒体艺人主页缺失：${id}.${platform}`);
    }
  }
}
if (
  !renderJs.includes("el('details', 'listen')") ||
  !renderJs.includes("el('summary', 'listen__summary')") ||
  !renderJs.includes("summary.setAttribute('aria-expanded'") ||
  !renderJs.includes("event.key !== 'Enter' && event.key !== ' '") ||
  !renderJs.includes("'未找到主页'") ||
  !renderJs.includes("'去听听'") ||
  !styleText.includes('.listen__links') ||
  !mainJs.includes('.card__body, .listen, .search') ||
  !standalone.includes('"musicLinks"') ||
  !standalone.includes("'去听听'")
) {
  throw new Error('“去听听”折叠组件、手势保护、样式或单文件数据不完整');
}

const fishmans = index.bands.find((band) => band.id === 'フィッシュマンズ');
const fishmansPlus = index.bands.find((band) => band.id === 'fishmans');
if (
  fishmans?.name !== 'Fishmans' ||
  !fishmans.aliases?.includes('フィッシュマンズ') ||
  fishmansPlus?.name !== 'Fishmans+'
) {
  throw new Error('Fishmans 主显示名、日文别名或 Fishmans+ 区分不正确');
}

const tenaciousD = bands.find((band) => band.id === 'tenacious-d');
if (
  tenaciousD?.musicLinks?.apple !==
    'https://music.apple.com/cn/artist/tenacious-d/1166315' ||
  !tenaciousD.intro?.startsWith('Tenacious D') ||
  /顽强的D|摇滚之神|浴火重生/.test(tenaciousD.intro ?? '')
) {
  throw new Error('Tenacious D 的 Apple Music 主页或原文专名回退');
}
const radiohead = bands.find((band) => band.id === 'radiohead');
if (
  !['Creep', 'Karma Police', 'Paranoid Android'].every((title) =>
    radiohead?.tracks?.includes(title)
  ) ||
  /电台司令|亲爱的派伯诺/.test(radiohead?.intro ?? '')
) {
  throw new Error('西方艺人的代表曲重新使用中文或日文译名');
}
const originalNameRegressions = [
  ['a-perfect-circle', /名之海|第十三阶|情绪渲染|工具乐团/],
  ['king-crimson', /在猩红之王的宫廷里/],
  ['fort-minor', /火线同盟|林肯公园/],
  ['the-yardbirds', /为了你的爱/],
  ['dead-by-sunrise', /黑暗曙光|破土重生/],
  ['metallica', /重Metallica|敲击Metallica/],
];
for (const [id, translated] of originalNameRegressions) {
  const band = bands.find((item) => item.id === id);
  if (!band?.intro?.includes(band.name) || translated.test(band.intro)) {
    throw new Error(`简介中的乐队、专辑或歌曲原名回退：${id}`);
  }
}
const rancid = bands.find((band) => band.id === 'rancid');
const peteBestBand = bands.find((band) => band.id === 'the-pete-best-band');
if (
  !rancid?.intro?.includes('于1991年成立') ||
  peteBestBand?.intro?.startsWith('The Pete Best Band是英国鼓手')
) {
  throw new Error('句中“也是”或人物传记被误当成乐队译名');
}

const versions = [
  indexHtml.match(/style\.css\?v=([a-zA-Z0-9._-]+)/)?.[1],
  indexHtml.match(/js\/main\.js\?v=([a-zA-Z0-9._-]+)/)?.[1],
  mainJs.match(/\.\/map\.js\?v=([a-zA-Z0-9._-]+)/)?.[1],
  mapJs.match(/const GRAPH_VERSION = '([^']+)'/)?.[1],
];
if (versions.some((version) => !version) || new Set(versions).size !== 1) {
  throw new Error(`静态资源版本不一致：${versions.join(', ')}`);
}
const dependencyVersions = [
  ...[...mainJs.matchAll(/from ['"]\.\/(?:data|layout|map|random|render)\.js\?v=([^'"]+)/g)]
    .map((match) => match[1]),
  renderJs.match(/from ['"]\.\/data\.js\?v=([^'"]+)/)?.[1],
];
if (
  dependencyVersions.length !== 6 ||
  dependencyVersions.some((version) => version !== versions[0])
) {
  throw new Error(`内部模块缓存版本不一致：${dependencyVersions.join(', ')}`);
}
if (!standalone.includes('BAND_ATLAS_DATA = {"index":') || !standalone.includes('"graph":{"generatedAt"')) {
  throw new Error('单文件版没有嵌入索引与全网地图数据');
}
if (!standalone.includes('createNetworkMap') || !standalone.includes('map-band-select')) {
  throw new Error('单文件版缺少地图代码或地图入口');
}
if (!standalone.includes('function chooseRandomBand') || !standalone.includes('RANDOM_REGION_SHARES')) {
  throw new Error('单文件版缺少分地区钟形随机算法');
}
if (!standalone.includes('简介资料：') || !standalone.includes('introSources')) {
  throw new Error('单文件版缺少人工简介的来源链接');
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
const greaterChinaIds = new Set(greaterChina.bands.map((band) => band.id));
const greaterChinaBands = bands.filter((band) => greaterChinaIds.has(band.id));
const greaterChinaIndex = index.bands.filter((band) => greaterChinaIds.has(band.id));
if (
  greaterChinaBands.length !== 28 ||
  greaterChinaIndex.length !== 28 ||
  greaterChinaBands.some(
    (band) =>
      band.quality?.templateIntro ||
      (band.quality?.score ?? 0) < 80 ||
      (band.albums?.length ?? 0) < 1 ||
      (band.tracks?.length ?? 0) < 4 ||
      !band.introSources?.length ||
      band.edges.length < 3
  ) ||
  greaterChinaIndex.some((band) => !band.regionalFeatured)
) {
  throw new Error('华语代表乐队精品卡、关系或地区精选标记不完整');
}
const greaterChinaCountries = Object.groupBy(greaterChinaIndex, (band) => band.countryCode);
if (
  greaterChinaCountries.CN?.length !== 12 ||
  greaterChinaCountries.TW?.length !== 10 ||
  greaterChinaCountries.HK?.length !== 6
) {
  throw new Error('华语增量不是大陆 12 / 台湾 10 / 香港 6');
}
if (
  RANDOM_REGION_SHARES['east-asia'] !== 0.55 ||
  RANDOM_REGION_SHARES.elsewhere !== 0.45
) {
  throw new Error('随机入口的地区份额不是东亚 55% / 非东亚 45%');
}
const bellPeak = bellPopularityWeight(0.68);
const bellTop = bellPopularityWeight(1);
const bellBottom = bellPopularityWeight(0);
if (!(bellPeak > bellTop && bellTop > bellBottom * 5)) {
  throw new Error('随机入口的钟形热度曲线不符合“中上段最多、顶流高于冷门”');
}
let randomState = 0x6d2b79f5;
const seededRandom = () => {
  randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState);
  return ((randomState ^ (randomState >>> 14)) >>> 0) / 4294967296;
};
const defaultRandomPool = randomPool.filter(
  (band) => band.listens >= 1000 || band.regionalFeatured
);
const sampledRegions = { 'east-asia': 0, elsewhere: 0 };
for (let sample = 0; sample < 30000; sample += 1) {
  const band = chooseRandomBand(defaultRandomPool, { random: seededRandom });
  const bucket = band.region === 'east-asia' ? 'east-asia' : 'elsewhere';
  sampledRegions[bucket] += 1;
}
for (const [region, expected] of Object.entries(RANDOM_REGION_SHARES)) {
  const actual = sampledRegions[region] / 30000;
  if (Math.abs(actual - expected) > 0.015) {
    throw new Error(`随机入口地区抽样异常：${region} ${actual.toFixed(3)}，预期 ${expected}`);
  }
}
const withPopularity = index.bands.filter((band) => Number.isFinite(band.listens)).length;
if (withPopularity !== index.bands.length) {
  throw new Error(`热度字段缺失：${withPopularity}/${index.bands.length}`);
}
const popularBands = index.bands.filter(
  (band) => band.listens >= 1000 || band.regionalFeatured
);
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
  ['Atarayo', 'あたらよ'],
  ['可惜夜', 'あたらよ'],
  ['萬能青年旅店', '万能青年旅店'],
  ['No Party For Cao Dong', '草东没有派对'],
  ['MLA', 'my little airport'],
  ['觸執毛', 'Chochukmo'],
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
for (const name of [
  'YOASOBI',
  'Vaundy',
  'Ado',
  'ヨルシカ',
  'Mrs. GREEN APPLE',
  'BAD HOP',
  'CUTIE STREET',
  'LANA',
  'クリープハイプ',
]) {
  const band = bands.find((item) => item.name === name);
  if (
    !band ||
    band.quality?.templateIntro ||
    band.introLang !== 'zh' ||
    (band.intro?.length ?? 0) < 20
  ) {
    throw new Error(`现代艺人的 Wikipedia 中文简介回退：${name}`);
  }
}
if (
  bands.some((band) => {
    const intro = band.intro?.trim() ?? '';
    return (
      /^(?:Mrs|MD|William L|Murder, Inc|Mt|Byul)\.?$/.test(intro) ||
      /(?:\b[A-Z]\.|(?:[A-Z]\.){2,})$/.test(intro)
    );
  })
) {
  throw new Error('Wikipedia 简介再次被英文姓名缩写截断');
}
const atarayo = bands.find((band) => band.id === 'atarayo');
const atarayoIndex = index.bands.find((band) => band.id === 'atarayo');
const atarayoTargets = new Set([
  'ヨルシカ',
  'back-number',
  '羊文学',
  'あいみょん',
]);
if (
  !atarayo ||
  !atarayoIndex ||
  atarayo.quality?.templateIntro ||
  (atarayo.quality?.score ?? 0) < 95 ||
  (atarayoIndex.listens ?? 0) < 1000 ||
  atarayo.albums?.length !== 5 ||
  (atarayo.tracks?.length ?? 0) < 8 ||
  !atarayo.lore ||
  atarayo.loreSources?.length !== 2 ||
  atarayo.links?.official !== 'https://atarayo-jp.com/' ||
  atarayo.edges?.length !== atarayoTargets.size ||
  atarayo.edges.some(
    (edge) =>
      edge.type !== 'scene' ||
      edge.label === '当代日本推荐' ||
      !atarayoTargets.has(edge.to)
  )
) {
  throw new Error('あたらよ手写卡片不完整或混入自动推荐');
}
const sourcedEditorialIds = [
  'adoy',
  'fishmans',
  'fzmz',
  'violent-magic-orchestra',
  '魚丁糸',
  'kimonos',
  'the-mortal',
  'hide-with-spread-beaver',
  'petit-brabancon',
  'vooid',
  '49-morphines',
  'パーランマウム',
];
for (const id of sourcedEditorialIds) {
  const band = bands.find((item) => item.id === id);
  if (
    !band ||
    band.quality?.templateIntro ||
    band.introLang !== 'zh' ||
    (band.intro?.length ?? 0) < 90 ||
    !(band.introSources?.length)
  ) {
    throw new Error(`东亚重点艺人的带来源简介回退：${id}`);
  }
}
const structuredTemplates = bands.filter((band) => band.quality?.templateIntro);
if (
  structuredTemplates.some(
    (band) =>
      (band.intro?.length ?? 0) < 45 ||
      !band.intro.includes('关系') ||
      band.intro.includes('目前资料收录了') ||
      band.intro.includes('MusicBrainz 还记录了它与')
  )
) {
  throw new Error('事实型模板简介重新退化为籍贯或旧式数据库说明');
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
