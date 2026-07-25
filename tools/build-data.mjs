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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'data/bands');
const TYPES = new Set(['member', 'guest', 'influence', 'feud', 'scene']);
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

const curated = await readJSON('data/source/scene-jrock.json');
const generated = await readJSON('data/source/generated.json', { bands: [], edges: [] });
const { intros } = await readJSON('data/source/intros.json', { intros: {} });
const translationsZh = await readJSON('data/source/translations-zh.json', {
  intros: {},
  areas: {},
  genres: {},
});
const zhOverrides = await readJSON('data/source/zh-overrides.json', { intros: {} });
const { edges: influenceEdges } = await readJSON('data/source/influences.json', { edges: [] });

// 维基百科的简介垫在爬来的数据上、人工数据下：有中文简介就用中文的，
// 人工写过的照旧以人工为准。
for (const band of generated.bands) {
  const hit = intros[band.mbid];
  if (hit) {
    band.intro = hit.intro;
    band.introLang = hit.lang;
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

/* ---------------------------------------------------------- 全站中文化 */

const hasHan = (text) => /[\u3400-\u9fff]/.test(text ?? '');
const countryFallback = {
  JP: '日本', KR: '韩国', KP: '朝鲜', CN: '中国', TW: '台湾', HK: '香港', MO: '澳门', MN: '蒙古',
  US: '美国', GB: '英国', IE: '爱尔兰', CA: '加拿大', AU: '澳大利亚', NZ: '新西兰',
  DE: '德国', FR: '法国', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛',
  NL: '荷兰', BE: '比利时', ES: '西班牙', IT: '意大利', PT: '葡萄牙', AT: '奥地利', CH: '瑞士',
};
const junkGenres = new Set([
  '2000s', '1990s', '1980s', '1970s', 'likedis auto', 'alliteration', 'seen live',
  'favorites', 'favourites', 'awesome', 'band', 'group', 'male vocalists', 'female vocalists',
]);

for (const band of merged.values()) {
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

  band.genres = [...new Set((band.genres ?? [])
    .filter((genre) => !junkGenres.has(genre.toLowerCase()))
    .map((genre) => {
      const translated = translationsZh.genres?.[genre];
      return hasHan(translated) ? translated : hasHan(genre) ? genre : null;
    })
    .filter((genre) => genre && genre !== band.area && genre !== countryFallback[band.countryCode]))];

  // 没有可翻译原文时只组合已有事实，不虚构经历或评价。
  if (!band.intro || !hasHan(band.intro)) {
    const place = band.area && band.area !== '地区未录入' ? `来自${band.area}的` : '';
    const genre = band.genres.length ? `以${band.genres.slice(0, 2).join('、')}为主要风格的` : '';
    const years = band.years ? `，活跃时期为${band.years}` : '';
    band.intro = `${band.name}是一支${place}${genre}音乐团体${years}。`;
    band.introLang = 'zh';
  }
  if (zhOverrides.intros?.[band.id]) {
    band.intro = zhOverrides.intros[band.id];
    band.introLang = 'zh';
  }
}

/* ---------------------------------------------------------------- 边 */

const problems = [];
const adjacency = new Map([...merged.keys()].map((id) => [id, []]));
const seen = new Set();
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
  };
}

// 人工的边先进，占住位置
curated.edges.forEach((e, i) => addEdge(e, `scene-jrock.edges[${i}]`));
generated.edges.forEach((e, i) =>
  addEdge({ ...e, from: remap.get(e.from) ?? e.from, to: remap.get(e.to) ?? e.to }, `generated.edges[${i}]`)
);
influenceEdges.forEach((e, i) =>
  addEdge(
    { ...e, from: remap.get(e.from) ?? e.from, to: remap.get(e.to) ?? e.to },
    `influences.edges[${i}]`
  )
);

/**
 * 一支乐队可能有几十条关系，屏幕边缘只摆得下八个，得挑。
 * 权重之外再给「更值得点进去」的对象加点分：人工整理过的（有中文简介和轶事）、
 * 以及作品多的。否则前八名基本是按 id 字母序碰运气。
 */
const notability = (id) => {
  const b = merged.get(id);
  return (b.curated ? 0.25 : 0) + Math.min((b.albums?.length ?? 0) * 0.02, 0.1);
};
for (const [, edges] of adjacency) {
  edges.sort(
    (a, b) =>
      b.weight + notability(b.to) - (a.weight + notability(a.to)) || a.to.localeCompare(b.to)
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

/* ------------------------------------------------------------ 产出 */

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

for (const [id, band] of merged) {
  const doc = {
    ...band,
    region: regionOf(band.countryCode),
    links: {
      musicbrainz: band.mbid
        ? `https://musicbrainz.org/artist/${band.mbid}`
        : `https://musicbrainz.org/search?query=${encodeURIComponent(band.name)}&type=artist`,
    },
    edges: adjacency.get(id),
  };
  delete doc.curated;
  await writeFile(path.join(OUT_DIR, `${id}.json`), JSON.stringify(doc, null, 2) + '\n');
}

const index = {
  scene: curated.scene,
  note: curated.note,
  generatedAt: new Date().toISOString().slice(0, 10),
  bands: [...merged.values()].map((b) => ({
    id: b.id,
    name: b.name,
    area: b.area ?? null,
    years: b.years ?? null,
    countryCode: b.countryCode ?? null,
    region: regionOf(b.countryCode),
    degree: adjacency.get(b.id).length,
  })),
};
await writeFile(path.join(root, 'data/index.json'), JSON.stringify(index, null, 2) + '\n');

/**
 * 关系地图的位置在构建时算好。以前这 420 轮力布局在每台手机第一次打开地图时运行，
 * 会和双指缩放抢主线程；现在浏览器只读取最终坐标。
 */
const layoutHash = (text) => {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
};
const layoutTextUnits = (text) =>
  [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 1 : 0.62), 0);
const layoutLabelWidth = (name) => Math.max(42, Math.min(188, layoutTextUnits(name) * 11 + 18));

function graphLayout(nodes, edges) {
  const points = new Map();
  [...nodes].sort((a, b) => layoutHash(a.id) - layoutHash(b.id)).forEach((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = 18 * Math.sqrt(index);
    points.set(node.id, {
      node,
      labelWidth: layoutLabelWidth(node.name),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    });
  });
  const links = edges
    .map((edge) => [points.get(edge.from), points.get(edge.to)])
    .filter(([a, b]) => a && b);
  const cellSize = 210;
  for (let step = 0; step < 420; step += 1) {
    const grid = new Map();
    for (const point of points.values()) {
      const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
      const bucket = grid.get(key) || [];
      bucket.push(point);
      grid.set(key, bucket);
    }
    for (const point of points.values()) {
      point.vx -= point.x * 0.00075;
      point.vy -= point.y * 0.00075;
      const gx = Math.floor(point.x / cellSize);
      const gy = Math.floor(point.y / cellSize);
      for (let x = gx - 1; x <= gx + 1; x += 1) for (let y = gy - 1; y <= gy + 1; y += 1) {
        for (const other of grid.get(`${x},${y}`) || []) {
          if (point === other || point.node.id > other.node.id) continue;
          let dx = other.x - point.x;
          const dy = other.y - point.y;
          if (dx === 0 && dy === 0) dx = 0.01;
          const overlapX = (point.labelWidth + other.labelWidth) / 2 + 10 - Math.abs(dx);
          const overlapY = 34 - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;
          if (overlapX < overlapY) {
            const push = Math.sign(dx) * overlapX * 0.055;
            point.vx -= push;
            other.vx += push;
          } else {
            const push = Math.sign(dy || 1) * overlapY * 0.075;
            point.vy -= push;
            other.vy += push;
          }
        }
      }
    }
    for (const [a, b] of links) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const target = (a.labelWidth + b.labelWidth) / 2 +
        Math.min(46, Math.max(a.labelWidth, b.labelWidth) * 0.48);
      const force = (distance - target) * 0.042;
      const fx = dx / distance * force;
      const fy = dy / distance * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const point of points.values()) {
      point.vx *= 0.58;
      point.vy *= 0.58;
      point.x += point.vx;
      point.y += point.vy;
    }
  }
  return points;
}

// 缩略地图不再逐支请求 JSON：一次拿到轻量节点和全量连线，Canvas 才能画出真正的网状图。
const graphEdges = [...seen].map((key) => {
  const [from, to, type] = key.split('|');
  return { from, to, type };
});
const graphNodes = [...merged.values()].map((b) => ({
  id: b.id,
  name: b.name,
  countryCode: b.countryCode ?? null,
  region: regionOf(b.countryCode),
  degree: adjacency.get(b.id).length,
  listens: b.listens ?? null,
  listeners: b.listeners ?? null,
}));
const layoutPositions = graphLayout(graphNodes, graphEdges);
const graph = {
  generatedAt: index.generatedAt,
  nodes: graphNodes.map((node) => {
    const point = layoutPositions.get(node.id);
    return {
      ...node,
      labelWidth: Math.round(point.labelWidth * 10) / 10,
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
    `\n  每队关系数：最少 ${Math.min(...degrees)}，最多 ${Math.max(...degrees)}，` +
    `平均 ${(degrees.reduce((a, b) => a + b, 0) / degrees.length).toFixed(1)}`
);
