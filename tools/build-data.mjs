#!/usr/bin/env node
/**
 * 合并两个数据源，展开成每支乐队一份的 JSON。
 *
 *   generated.json   由 tools/crawl.mjs 从 MusicBrainz 爬来，量大但只有硬事实
 *   scene-jrock.json 人工整理，量小但有中文简介、轶事，以及数据库里根本没有的恩怨
 *   influences.json  Wikidata P737 关系；只保留两端都在本网里的影响边
 *
 * 人工的那份是覆盖层：同一支乐队，人工写了什么就以什么为准，
 * 没写的字段才用爬来的补。乐队 id 也以人工那份为准，
 * 已经分享出去的链接（#/band/straightener）不能因为重跑数据就失效。
 *
 *   node tools/build-data.mjs
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toHiragana, toKatakana, toRomaji } from 'wanakana';
import { layoutGraphOffline } from './lib/layout-graph.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'data/bands');
const TYPES = new Set(['member', 'guest', 'influence', 'feud', 'scene']);
const MUSIC_LINK_PATTERNS = {
  qq: /^https:\/\/i\.y\.qq\.com\/n2\/m\/share\/details\/singer\.html\?ADTAG=newyqq\.singer&singermid=[A-Za-z0-9]+$/,
  netease: /^https:\/\/y\.music\.163\.com\/m\/artist\?id=\d+$/,
  apple: /^https:\/\/music\.apple\.com\/[a-z]{2}\/artist\/[^/]+\/\d+$/,
  spotify: /^https:\/\/open\.spotify\.com\/artist\/[A-Za-z0-9]+$/,
};
const EAST_ASIA = new Set(['JP', 'KR', 'KP', 'CN', 'TW', 'HK', 'MO', 'MN']);
const WESTERN = new Set([
  'US', 'GB', 'IE', 'CA', 'AU', 'NZ', 'DE', 'FR', 'SE', 'NO', 'DK', 'FI', 'IS', 'NL', 'BE', 'ES',
  'IT', 'PT', 'AT', 'CH',
]);
const regionOf = (countryCode) =>
  EAST_ASIA.has(countryCode) ? 'east-asia' : WESTERN.has(countryCode) ? 'western' : countryCode ? 'other' : 'unknown';

async function readJSON(rel, fallback = null) {
  try {
    return JSON.parse(await readFile(path.join(root, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

const sceneJrock = await readJSON('data/source/scene-jrock.json');
const greaterChina = await readJSON('data/source/greater-china.json', { bands: [], edges: [] });
const curated = {
  ...sceneJrock,
  bands: [
    ...sceneJrock.bands,
    ...greaterChina.bands.map((band) => ({ ...band, regionalFeatured: true })),
  ],
  edges: [...sceneJrock.edges, ...greaterChina.edges],
};
const generatedBase = await readJSON('data/source/generated.json', { bands: [], edges: [] });
const modernJapan = await readJSON('data/source/modern-japan.json', { bands: [], edges: [] });
const generated = {
  bands: [...generatedBase.bands, ...modernJapan.bands],
  edges: [...generatedBase.edges, ...modernJapan.edges],
};
const artistAliases = await readJSON('data/source/artist-aliases.json', { artists: {} });
const { intros } = await readJSON('data/source/intros.json', { intros: {} });
const translationsZh = await readJSON('data/source/translations-zh.json', {
  intros: {},
  areas: {},
  genres: {},
});
const zhOverrides = await readJSON('data/source/zh-overrides.json', {
  names: {},
  intros: {},
  introSources: {},
  links: {},
});
const musicLinks = await readJSON('data/source/music-links.json', { artists: {} });
const { edges: influenceEdges } = await readJSON('data/source/influences.json', { edges: [] });
const { edges: guestEdges } = await readJSON('data/source/guest-edges.json', { edges: [] });
const popularityData = await readJSON('data/source/popularity.json', { artists: {} });
const wikidataEnrichment = await readJSON('data/source/wikidata-enrichment.json', {
  genres: {},
  tracks: {},
});
const historyReview = await readJSON('data/review/history-candidates.json', { candidates: [] });
const approvedHistory = (historyReview.candidates ?? []).filter(
  (candidate) => candidate.status === 'approved'
);
const popularSeeds = await readJSON('data/source/popular-seeds.json', { seeds: [] });
const popularityByMbid = new Map(
  Object.entries(popularityData.artists ?? {}).map(([mbid, value]) => [mbid, value])
);
for (const seed of popularSeeds.seeds ?? []) {
  if (!popularityByMbid.has(seed.mbid)) {
    popularityByMbid.set(seed.mbid, { listens: seed.listens ?? 0, listeners: null });
  }
}

// 维基百科的简介垫在爬来的数据与现代日本增量上、人工数据下：
// 有中文简介就用中文的，人工写过的照旧以人工为准。
for (const band of generated.bands) {
  const hit = intros[band.mbid];
  // 真正的中文内容优先；自动生成的中文模板只是一层兜底，任何语言的
  // Wikipedia 首段都比它信息更完整，外文会在合并后走翻译缓存。
  const hasChineseFallback =
    band.introLang === 'zh' &&
    band.intro &&
    !band.introTemplate;
  if (hit && (hit.lang === 'zh' || !hasChineseFallback)) {
    band.intro = hit.intro;
    band.introLang = hit.lang;
    band.introTemplate = false;
  }
}

/* ------------------------------------------------------------ 对齐两份数据 */

// MusicBrainz 用的是弯撇号（Guns N’ Roses），人工数据里多半敲的是直撇号，
// 不折叠掉的话同一支乐队会变成两个节点。连字号、引号同理。
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[‘’ʼ＇]/g, "'")
    .replace(/[‐-―−]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

// 爬来的乐队先按 mbid 与名字各建一份索引，好让人工那份认领
const genByMbid = new Map(generated.bands.map((b) => [b.mbid, b]));
const genByName = new Map(generated.bands.map((b) => [norm(b.name), b]));

const remap = new Map(); // 爬来的 id → 最终 id
const merged = new Map(); // 最终 id → 乐队
const claimed = new Set(); // 已经被人工数据认领的爬取条目

/** 人工写了的字段才覆盖：空数组、空字符串都当没写。 */
const filled = (v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);

for (const band of curated.bands) {
  const gen = (band.mbid && genByMbid.get(band.mbid)) || genByName.get(norm(band.name));
  if (gen) {
    claimed.add(gen.id);
    remap.set(gen.id, band.id);
  }
  const out = { ...(gen ?? {}) };
  for (const [k, v] of Object.entries(band)) if (filled(v)) out[k] = v;
  if (filled(band.intro)) out.introLang = 'zh';
  out.id = band.id; // 人工 id 说了算
  out.curated = true;
  merged.set(band.id, out);
}

for (const band of generated.bands) {
  if (claimed.has(band.id)) continue;
  if (merged.has(band.id)) {
    // 人工那份已经占了这个 id 却不是同一支乐队，给爬来的换个名字免得覆盖
    const alt = `${band.id}-${band.mbid.slice(0, 6)}`;
    remap.set(band.id, alt);
    merged.set(alt, { ...band, id: alt });
    continue;
  }
  remap.set(band.id, band.id);
  merged.set(band.id, band);
}

for (const [id, links] of Object.entries(musicLinks.artists ?? {})) {
  if (!merged.has(id)) throw new Error(`流媒体链接指向不存在的乐队：${id}`);
  for (const [platform, url] of Object.entries(links)) {
    const pattern = MUSIC_LINK_PATTERNS[platform];
    if (!pattern) throw new Error(`流媒体链接使用未知平台：${id}.${platform}`);
    if (typeof url !== 'string' || !pattern.test(url)) {
      throw new Error(`流媒体艺人主页格式不正确：${id}.${platform} = ${url}`);
    }
  }
}

// 审核单是唯一入口：只有明确改成 approved 的中文稿和关系边才会进入站点。
// pending / needs-more-sources / rejected 在构建时全部忽略。
for (const candidate of approvedHistory) {
  const band = merged.get(candidate.bandId);
  if (!band || !candidate.proposedLore) continue;
  band.lore = band.lore
    ? `${band.lore} ${candidate.proposedLore}`
    : candidate.proposedLore;
  if (candidate.source) {
    const languageName = { zh: '中文', ja: '日文', en: '英文' }[candidate.sourceLanguage];
    const source = {
      label: `Wikipedia${languageName ? `（${languageName}）` : ''}`,
      url: candidate.source,
    };
    band.loreSources = [...(band.loreSources ?? [])];
    if (!band.loreSources.some((item) => item.url === source.url)) {
      band.loreSources.push(source);
    }
  }
}

/* ---------------------------------------------------------- 全站中文化 */

const hasHan = (text) => /[\u3400-\u9fff]/.test(text ?? '');
const countryFallback = {
  JP: '日本', KR: '韩国', KP: '朝鲜', CN: '中国', TW: '台湾', HK: '香港', MO: '澳门', MN: '蒙古',
  US: '美国', GB: '英国', IE: '爱尔兰', CA: '加拿大', AU: '澳大利亚', NZ: '新西兰',
  DE: '德国', FR: '法国', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛',
  NL: '荷兰', BE: '比利时', ES: '西班牙', IT: '意大利', PT: '葡萄牙', AT: '奥地利', CH: '瑞士',
};
const areaCountryRules = [
  {
    code: 'JP',
    pattern: /日本|东京|東京都|大阪|京都|北海道|札幌|福冈|福岡|奈良|横滨|横浜|千叶|千葉|埼玉|神奈川|青森|函馆|函館|群马|群馬|兵库|兵庫|名古屋|爱知|愛知|广岛|広島|仙台|宫城|宮城|冲绳|沖縄|静冈|静岡|长野|長野|新潟|石川|富山|山梨|岐阜|三重|滋贺|滋賀|和歌山|鸟取|鳥取|岛根|島根|冈山|岡山|山口|德岛|徳島|香川|爱媛|愛媛|高知|佐贺|佐賀|长崎|長崎|熊本|大分|宫崎|宮崎|鹿儿岛|鹿児島|立山|涩谷|渋谷|品川|白金台/,
  },
  { code: 'KR', pattern: /韩国|韓國|首尔|首爾|釜山|仁川|大邱|光州|大田|蔚山|济州|濟州|清州/ },
  { code: 'CN', pattern: /中国|中國|北京|上海|广州|廣州|深圳|成都|武汉|武漢|西安|南京|杭州|重庆|重慶|天津/ },
  { code: 'TW', pattern: /台湾|臺灣|台北|臺北|高雄|台中|臺中|台南|臺南|新北/ },
  { code: 'HK', pattern: /香港|九龙|九龍/ },
  { code: 'MO', pattern: /澳门|澳門/ },
  { code: 'MN', pattern: /蒙古|乌兰巴托|烏蘭巴托/ },
];
const inferCountryFromArea = (area) =>
  areaCountryRules.find((rule) => rule.pattern.test(area ?? ''))?.code ?? null;
const junkGenres = new Set([
  '2000s', '1990s', '1980s', '1970s', 'likedis auto', 'alliteration', 'seen live',
  'favorites', 'favourites', 'awesome', 'band', 'group', 'male vocalists', 'female vocalists',
]);
const genreLabelZh = {
  'stoner metal': '迷幻金属',
  'ラテン・ロック': '拉丁摇滚',
  'Trip hop': '神游舞曲',
  'クラシック・ロック': '经典摇滚',
  Emo: '情绪摇滚',
  'sleaze rock': '华丽硬摇滚',
  'ガレージ・パンク': '车库朋克',
  funky: '放克',
  'エキゾチカ': '异域音乐',
  NDH: '新德意志硬派',
  '日本のスカ': '日本斯卡',
  Screamo: '尖叫情绪摇滚',
};

for (const band of merged.values()) {
  band.introTemplate ??= false;
  if (band.mbid) {
    band.aliases = [...new Set([
      ...(band.aliases ?? []),
      ...(artistAliases.artists?.[band.mbid] ?? []),
    ].filter(Boolean))];
  }
  const preferredName = zhOverrides.names?.[band.id];
  if (preferredName && norm(preferredName) !== norm(band.name)) {
    band.aliases = [...new Set([...(band.aliases ?? []), band.name])];
    band.name = preferredName;
  }
  const introTranslation = band.mbid && translationsZh.intros?.[band.mbid];
  if (
    introTranslation?.text &&
    (!introTranslation.source || introTranslation.source === band.intro) &&
    band.introLang !== 'zh'
  ) {
    band.intro = introTranslation.text;
    band.introLang = 'zh';
  }

  if (band.area) {
    const translated = translationsZh.areas?.[band.area];
    band.area = hasHan(translated)
      ? translated
      : hasHan(band.area)
        ? band.area
        : countryFallback[band.countryCode] ?? '地区未录入';
  } else if (countryFallback[band.countryCode]) {
    band.area = countryFallback[band.countryCode];
  }
  if (!band.countryCode) {
    const areaCountry = inferCountryFromArea(band.area);
    const scriptCountry = /[\u3040-\u30ff]/u.test(band.name ?? '')
      ? 'JP'
      : /[\uac00-\ud7af]/u.test(band.name ?? '')
        ? 'KR'
        : null;
    if (areaCountry || scriptCountry) {
      band.countryCode = areaCountry ?? scriptCountry;
      band.countryInferred = areaCountry ? 'area' : 'name-script';
    }
  }

  const enrichedGenres = band.mbid ? wikidataEnrichment.genres?.[band.mbid] ?? [] : [];
  band.genres = [...new Set([...(band.genres ?? []), ...enrichedGenres]
    .filter((genre) => !junkGenres.has(genre.toLowerCase()))
    .map((genre) => {
      const translated = translationsZh.genres?.[genre];
      return hasHan(translated)
        ? translated
        : genreLabelZh[genre] ?? (hasHan(genre) && !/[A-Za-z\u3040-\u30ff\uac00-\ud7af]/u.test(genre) ? genre : null);
    })
    .filter((genre) => genre && genre !== band.area && genre !== countryFallback[band.countryCode]))];

  if (!(band.tracks?.length > 0) && band.mbid) {
    const trackCandidates = wikidataEnrichment.tracks?.[band.mbid] ?? [];
    if (trackCandidates.length) {
      band.tracks = trackCandidates.slice(0, 5).map((track) => track.title);
      band.trackSources = trackCandidates.slice(0, 5).map((track) => ({
        title: track.title,
        wikidata: track.wikidata,
      }));
    }
  }

  // 没有可翻译原文时只组合已有事实，不虚构经历或评价。
  if (!band.intro || !hasHan(band.intro)) {
    const place = band.area && band.area !== '地区未录入' ? `来自${band.area}的` : '';
    const genre = band.genres.length ? `以${band.genres.slice(0, 2).join('、')}为主要风格的` : '';
    const years = band.years ? `，活跃时期为${band.years}` : '';
    const subject = band.artistType === 'Person' ? '音乐人' : '音乐团体';
    band.intro = `${band.name}是${place}${genre}${subject}${years}。`;
    band.introLang = 'zh';
    band.introTemplate = true;
  }
  if (zhOverrides.intros?.[band.id]) {
    band.intro = zhOverrides.intros[band.id];
    band.introLang = 'zh';
    band.introTemplate = false;
    band.introSources = zhOverrides.introSources?.[band.id] ?? [];
    band.links = {
      ...(band.links ?? {}),
      ...(zhOverrides.links?.[band.id] ?? {}),
    };
  }
  const verifiedMusicLinks = musicLinks.artists?.[band.id];
  band.musicLinks = verifiedMusicLinks ? { ...verifiedMusicLinks } : {};
  const popularity = band.mbid ? popularityByMbid.get(band.mbid) : null;
  band.listens = popularity?.listens ?? 0;
  band.listeners = popularity?.listeners ?? null;
}

/* ---------------------------------------------------------------- 边 */

const problems = [];
const adjacency = new Map([...merged.keys()].map((id) => [id, []]));
const seen = new Set();
const graphEdgeDetails = new Map();
const pairKey = (a, b, t) => [a, b].sort().join('|') + '|' + t;

function addEdge(e, where) {
  const from = e.from;
  const to = e.to;
  if (!merged.has(from) || !merged.has(to)) {
    problems.push(`${where}：${from} → ${to} 指向不存在的乐队`);
    return;
  }
  if (!TYPES.has(e.type)) {
    problems.push(`${where}：未知关系类型 "${e.type}"`);
    return;
  }
  if (from === to) return;

  const key = pairKey(from, to, e.type);
  if (seen.has(key)) return; // 人工的先进来，所以重复的以人工为准
  seen.add(key);
  graphEdgeDetails.set(key, {
    from,
    to,
    type: e.type,
    weight: e.weight ?? 0.5,
  });

  adjacency.get(from).push(makeEdge(e, to, e.detail));
  adjacency.get(to).push(makeEdge(e, from, e.detailRev ?? e.detail));
}

function makeEdge(e, otherId, detail) {
  const other = merged.get(otherId);
  return {
    to: otherId,
    toName: other.name,
    toArea: other.area ?? null,
    toYears: other.years ?? null,
    type: e.type,
    label: e.label,
    detail: detail ?? null,
    year: e.year ?? null,
    weight: e.weight ?? 0.5,
    sources: Array.isArray(e.sources) ? e.sources : [],
  };
}

// 人工的边先进，占住位置
curated.edges.forEach((e, i) => addEdge(e, `scene-jrock.edges[${i}]`));
approvedHistory
  .filter((candidate) => candidate.proposedEdge)
  .forEach((candidate, i) =>
    addEdge(
      {
        ...candidate.proposedEdge,
        detail: candidate.proposedLore,
        detailRev: candidate.proposedLore,
        sources: [candidate.source],
      },
      `history-candidates.approved[${i}]`
    )
  );
generated.edges.forEach((e, i) =>
  addEdge({ ...e, from: remap.get(e.from) ?? e.from, to: remap.get(e.to) ?? e.to }, `generated.edges[${i}]`)
);
influenceEdges.forEach((e, i) =>
  addEdge(
    { ...e, from: remap.get(e.from) ?? e.from, to: remap.get(e.to) ?? e.to },
    `influences.edges[${i}]`
  )
);
guestEdges.forEach((e, i) =>
  addEdge(
    { ...e, from: remap.get(e.from) ?? e.from, to: remap.get(e.to) ?? e.to },
    `guest-edges.edges[${i}]`
  )
);

// MusicBrainz 的合作项目、临时团常缺地区。若一支未知团体至少有两条成员关系，
// 且已知邻居中有不低于 75% 来自同一国家，继承这个国家并保留推断标记。
// 一条边或势均力敌的跨国项目都不猜。
for (const [id, band] of merged) {
  if (band.countryCode) continue;
  const counts = new Map();
  for (const edge of adjacency.get(id).filter((item) => item.type === 'member')) {
    const code = merged.get(edge.to)?.countryCode;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const known = ranked.reduce((sum, [, count]) => sum + count, 0);
  if (ranked[0]?.[1] >= 2 && ranked[0][1] / known >= 0.75) {
    band.countryCode = ranked[0][0];
    band.countryInferred = 'member-neighbors';
    if (!band.area || band.area === '地区未录入') band.area = countryFallback[band.countryCode];
  }
}

/* -------------------------------------------- 推歌站准入：美国项目须有完整专辑 */

// 产品目标是推歌，不再保留只承担成员履历或前身说明作用的美国临时项目。
// crawl.mjs 的 albums 只包含 MusicBrainz primary-type=Album、无 secondary type、
// 且有首发年份的发行组，因此这里的“至少一张”对应可确认已经发行的完整录音室专辑。
const prunedNoAlbumUs = new Set(
  [...merged]
    .filter(([, band]) => band.countryCode === 'US' && !(band.albums?.length))
    .map(([id]) => id)
);
const adjacencyBeforeAlbumPrune = new Map(
  [...adjacency].map(([id, edges]) => [id, edges.map((edge) => ({ ...edge }))])
);
const connectedBeforeAlbumPrune = new Set(
  [...adjacency].filter(([, edges]) => edges.length).map(([id]) => id)
);
for (const id of prunedNoAlbumUs) {
  merged.delete(id);
  adjacency.delete(id);
}
for (const [id, edges] of adjacency) {
  adjacency.set(id, edges.filter((edge) => !prunedNoAlbumUs.has(edge.to)));
}
for (const [key, edge] of graphEdgeDetails) {
  if (prunedNoAlbumUs.has(edge.from) || prunedNoAlbumUs.has(edge.to)) {
    graphEdgeDetails.delete(key);
    seen.delete(key);
  }
}

// 若一支有完整专辑的乐队唯一连线恰好经过被删的临时项目，不让它跟着成为孤岛。
// 优先连接到原项目的另一位两跳邻居；没有可用两跳对象时，才按同国、流派和热度推荐。
// 这条虚线明确标成“推荐”，不冒充成员、合作或影响事实。
const strandedAlbumBands = [...merged]
  .filter(
    ([id, band]) =>
      connectedBeforeAlbumPrune.has(id) &&
      !adjacency.get(id).length &&
      (band.albums?.length ?? 0) > 0
  )
  .sort(([a], [b]) => a.localeCompare(b));
for (const [id, band] of strandedAlbumBands) {
  const removedNeighbors = (adjacencyBeforeAlbumPrune.get(id) ?? [])
    .filter((edge) => prunedNoAlbumUs.has(edge.to))
    .map((edge) => edge.to);
  const contractedCandidates = new Set(
    removedNeighbors.flatMap((removedId) =>
      (adjacencyBeforeAlbumPrune.get(removedId) ?? []).map((edge) => edge.to)
    )
  );
  contractedCandidates.delete(id);
  const ownGenres = new Set(band.genres ?? []);
  const eligible = [...merged]
    .filter(
      ([candidateId, candidate]) =>
        candidateId !== id &&
        adjacency.get(candidateId)?.length &&
        (candidate.albums?.length ?? 0) > 0
    )
    .map(([candidateId, candidate]) => {
      const sharedGenres = (candidate.genres ?? []).filter((genre) => ownGenres.has(genre)).length;
      const score =
        (contractedCandidates.has(candidateId) ? 12 : 0) +
        (candidate.countryCode === band.countryCode ? 3 : 0) +
        sharedGenres * 4 +
        Math.log10((candidate.listens ?? 0) + 1) * 0.25;
      return { candidateId, score };
    })
    .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));
  const target = eligible[0]?.candidateId;
  if (!target) continue;
  addEdge(
    {
      from: id,
      to: target,
      type: 'scene',
      weight: 0.28,
      label: '完整专辑推荐',
      detail: '按原关系链、流派与收听热度生成的推荐，不表示成员或合作事实。',
    },
    `album-recommendation.${id}`
  );
}

/**
 * 一支乐队可能有几十条关系，屏幕边缘只摆得下八个，得挑。
 * 权重之外再给「更值得点进去」的对象加点分：人工整理过的（有中文简介和轶事）、
 * 以及作品多的。否则前八名基本是按 id 字母序碰运气。
 */
const notability = (id) => {
  const b = merged.get(id);
  return (b.curated ? 0.25 : 0) + Math.min((b.albums?.length ?? 0) * 0.02, 0.1);
};
const relationPriority = {
  member: 0.16,
  feud: 0.12,
  guest: 0.08,
  influence: 0.04,
  scene: 0,
};
for (const [, edges] of adjacency) {
  edges.sort(
    (a, b) =>
      b.weight + relationPriority[b.type] + notability(b.to) -
        (a.weight + relationPriority[a.type] + notability(a.to)) ||
      a.to.localeCompare(b.to)
  );
}

/* -------------------------------------------------- 丢掉走不到的孤岛 */

const isolated = [...adjacency].filter(([, e]) => e.length === 0).map(([id]) => id);
for (const id of isolated) {
  if (merged.get(id).curated) {
    problems.push(`${id}：人工数据里的乐队没有任何关系，会成为孤岛`);
    continue;
  }
  merged.delete(id);
  adjacency.delete(id);
}

if (problems.length) {
  console.error('数据校验未通过：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

const workTitle = (title) => `《${title}》`;
const yearLabel = (year) => (year ? `${year}年的` : '');
const activeLabel = (years) => {
  if (!years) return '';
  if (/^\d{4}–$/.test(years)) return `${years.slice(0, 4)}年至今活跃`;
  if (/^\d{4}–\d{4}$/.test(years)) {
    const [from, to] = years.split('–');
    if (from === to) return `${from}年活跃`;
    return `${from}至${to}年间活跃`;
  }
  return `活跃时期为${years}`;
};
const memberNames = (label) =>
  (label ?? '')
    .split('・')
    .map((name) => name.trim())
    .filter((name) => name && name !== '副项目');
const NON_GENRE_TAGS = new Set([
  '合作',
  '阿凡达',
  '翻唱',
  'Covers',
  'Star Trek',
  'Go Down Records',
  'Rami Jaffee',
  'Columbus [Oh]',
]);

// 对没有百科正文的卡片，使用作品与关系数据生成两三句“推歌型事实简介”。
// 它们仍保留 templateIntro 标记，不会冒充人工文案或进入精品随机首屏。
for (const [id, band] of merged) {
  if (!band.introTemplate) continue;

  const place =
    band.area && band.area !== '地区未录入' && band.area !== '[全球]'
      ? `来自${band.area}`
      : '';
  const active = activeLabel(band.years);
  const subject = band.artistType === 'Person' ? '音乐人' : '音乐团体';
  const identity = [place, active].filter(Boolean).join('、');
  const genres = [...new Set(band.genres ?? [])]
    .filter((genre) => !NON_GENRE_TAGS.has(genre))
    .slice(0, 2);
  const sentences = [
    `${band.name}是${identity ? `${identity}的` : ''}${subject}` +
      `${genres.length ? `，现有资料将其归入${genres.join('、')}` : ''}。`,
  ];

  const tracks = [...new Set(band.tracks ?? [])].slice(0, 3);
  const albums = [...(band.albums ?? [])]
    .filter((album) => album?.title)
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title));
  let entryWork = null;
  if (tracks.length) {
    entryWork = workTitle(tracks[0]);
    sentences.push(`想从歌曲进入，可以先听${tracks.map(workTitle).join('、')}。`);
  } else if (albums.length === 1) {
    entryWork = workTitle(albums[0].title);
    sentences.push(
      `现有唱片目录收录了${yearLabel(albums[0].year)}${entryWork}。`
    );
  } else if (albums.length > 1) {
    const first = albums[0];
    const last = albums.at(-1);
    entryWork = workTitle(first.title);
    sentences.push(first.year && first.year === last.year
      ? `${first.year}年的唱片目录包括${entryWork}和${workTitle(last.title)}。`
      : `现有唱片目录可从${yearLabel(first.year)}${entryWork}` +
        `一路听到${yearLabel(last.year)}${workTitle(last.title)}。`);
  }

  const relationEdges = [...adjacency.get(id)]
    .filter(
      (edge) =>
        edge.type === 'member' ||
        edge.type === 'guest' ||
        (edge.type === 'scene' && edge.label === '完整专辑推荐')
    )
    .sort((a, b) => {
      const aBand = merged.get(a.to);
      const bBand = merged.get(b.to);
      const aScore =
        (a.type === 'member' ? 2 : 0) +
        a.weight +
        Math.log10((aBand?.listens ?? 0) + 1) / 8;
      const bScore =
        (b.type === 'member' ? 2 : 0) +
        b.weight +
        Math.log10((bBand?.listens ?? 0) + 1) / 8;
      return bScore - aScore || a.to.localeCompare(b.to);
    });
  const selectedRelations = [];
  const usedTargets = new Set();
  for (const edge of relationEdges) {
    if (usedTargets.has(edge.to)) continue;
    selectedRelations.push(edge);
    usedTargets.add(edge.to);
    if (selectedRelations.length === 1) break;
  }

  const relationFacts = selectedRelations.map((edge) => {
    const names = memberNames(edge.label);
    if (edge.label === '副项目') {
      return `MusicBrainz将它记录为${edge.toName}的副项目`;
    }
    if (edge.type === 'scene') {
      return `本站按原关系链、流派与热度把它和${edge.toName}放在同一条推荐路径上（不表示合作或影响）`;
    }
    if (edge.type === 'guest') {
      const guest = names
        .map((name) => name.replace(/^客串：/, ''))
        .filter((name) => name && name !== '合作' && name !== '伴奏' && name !== '助演');
      return guest.length
        ? `${guest.join('、')}把它与${edge.toName}的录音联系起来`
        : `录音资料记录了它与${edge.toName}的合作联系`;
    }
    if (names.length) {
      return `${names.join('、')}的履历把它与${edge.toName}连接起来`;
    }
    return `成员资料把它与${edge.toName}连接起来`;
  });
  if (relationFacts.length) {
    sentences.push(`理解这个项目的另一条线索是成员关系：${relationFacts.join('；')}。`);
  }

  if (entryWork && selectedRelations.length) {
    sentences.push(
      `从${selectedRelations[0].toName}沿关系网点进来时，${entryWork}可以作为试听入口。`
    );
  }
  band.intro = sentences.join('');
}

for (const [id, band] of merged) {
  const degree = adjacency.get(id).length;
  const hasGenres = (band.genres?.length ?? 0) > 0;
  const hasTracks = (band.tracks?.length ?? 0) > 0;
  const hasLore = Boolean(band.lore);
  const hasAlbums = (band.albums?.length ?? 0) > 0;
  const score = Math.round(
    (band.introTemplate ? 0 : 42) +
    Math.min(band.genres?.length ?? 0, 3) * 6 +
    Math.min(band.tracks?.length ?? 0, 3) * 6 +
    (hasLore ? 10 : 0) +
    (hasAlbums ? 8 : 0) +
    Math.min(degree, 8) / 2
  );
  band.quality = {
    score: Math.min(100, score),
    templateIntro: band.introTemplate,
    hasGenres,
    hasTracks,
    hasLore,
    hasAlbums,
  };
  delete band.introTemplate;
}

/* ------------------------------------------------------------ 产出 */

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

for (const [id, band] of merged) {
  const doc = {
    ...band,
    region: regionOf(band.countryCode),
    links: {
      ...(band.links ?? {}),
      musicbrainz: band.mbid
        ? `https://musicbrainz.org/artist/${band.mbid}`
        : `https://musicbrainz.org/search?query=${encodeURIComponent(band.name)}&type=artist`,
    },
    edges: adjacency.get(id),
  };
  delete doc.curated;
  // 别名只用于一次加载的全局搜索索引，避免每张详情卡重复携带同一份数据。
  delete doc.aliases;
  await writeFile(path.join(OUT_DIR, `${id}.json`), JSON.stringify(doc, null, 2) + '\n');
}

const index = {
  scene: curated.scene,
  note: curated.note,
  generatedAt: new Date().toISOString().slice(0, 10),
  bands: [...merged.values()].map((b) => {
    const aliases = [...new Set((b.aliases ?? []).filter((alias) => alias && norm(alias) !== norm(b.name)))];
    const searchable = [b.name, ...aliases, b.area].filter(Boolean);
    const searchKeys = [...new Set(searchable.flatMap((text) => [
      text,
      toHiragana(text),
      toKatakana(text),
      toRomaji(text),
    ].map((value) =>
      value
        .normalize('NFKC')
        .toLocaleLowerCase('ja')
        .replace(/[\s・･._'’\-–—]+/g, '')
    )))];
    return {
      id: b.id,
      name: b.name,
      aliases,
      searchKeys,
      artistType: b.artistType ?? 'Group',
      area: b.area ?? null,
      years: b.years ?? null,
      countryCode: b.countryCode ?? null,
      region: regionOf(b.countryCode),
      degree: adjacency.get(b.id).length,
      listens: b.listens ?? 0,
      listeners: b.listeners ?? null,
      ...(b.regionalFeatured ? { regionalFeatured: true } : {}),
      quality: b.quality,
    };
  }),
};
await writeFile(path.join(root, 'data/index.json'), JSON.stringify(index, null, 2) + '\n');

/** 关系地图的位置在构建期由 ForceAtlas2 与防碰撞布局一次算好。 */
const layoutTextUnits = (text) =>
  [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 1 : 0.62), 0);
const layoutLabelWidth = (name) => Math.max(42, Math.min(188, layoutTextUnits(name) * 11 + 18));

// 缩略地图不再逐支请求 JSON：一次拿到轻量节点和全量连线，Canvas 才能画出真正的网状图。
const graphEdges = [...graphEdgeDetails.values()]
  .filter((edge) => merged.has(edge.from) && merged.has(edge.to));
const graphNodes = [...merged.values()].map((b) => ({
  id: b.id,
  name: b.name,
  countryCode: b.countryCode ?? null,
  region: regionOf(b.countryCode),
  degree: adjacency.get(b.id).length,
  listens: b.listens ?? 0,
  listeners: b.listeners ?? null,
  ...(b.regionalFeatured ? { regionalFeatured: true } : {}),
  labelWidth: layoutLabelWidth(b.name),
}));
const { positions: layoutPositions, metadata: layoutMetadata, milliseconds: layoutMilliseconds } =
  layoutGraphOffline(graphNodes, graphEdges);
const graph = {
  generatedAt: index.generatedAt,
  layout: layoutMetadata,
  nodes: graphNodes.map((node) => {
    const point = layoutPositions.get(node.id);
    return {
      ...node,
      labelWidth: Math.round(node.labelWidth * 10) / 10,
      x: Math.round(point.x * 10) / 10,
      y: Math.round(point.y * 10) / 10,
    };
  }),
  edges: graphEdges,
};
await writeFile(path.join(root, 'data/graph.json'), JSON.stringify(graph) + '\n');

const degrees = index.bands.map((b) => b.degree);
const edgeCount = seen.size;
console.log(
  `✓ ${merged.size} 支乐队 / ${edgeCount} 条关系` +
    (isolated.length ? `（丢掉 ${isolated.length} 个孤岛）` : '') +
    `\n  推歌准入：移除 ${prunedNoAlbumUs.size} 支没有完整专辑的美国项目` +
    `，保留并重连 ${strandedAlbumBands.length} 支完整专辑乐队` +
    `\n  每队关系数：最少 ${Math.min(...degrees)}，最多 ${Math.max(...degrees)}，` +
    `平均 ${(degrees.reduce((a, b) => a + b, 0) / degrees.length).toFixed(1)}` +
    `\n  离线布局：${layoutMetadata.algorithm}，${layoutMetadata.components} 个分量，` +
    `标签重叠 ${layoutMetadata.overlaps}，${layoutMilliseconds}ms`
);
