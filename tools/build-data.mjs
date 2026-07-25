#!/usr/bin/env node
/**
 * 合并两个数据源，展开成每支乐队一份的 JSON。
 *
 *   generated.json   由 tools/crawl.mjs 从 MusicBrainz 爬来，量大但只有硬事实
 *   scene-jrock.json 人工整理，量小但有中文简介、轶事，以及数据库里根本没有的恩怨
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
    degree: adjacency.get(b.id).length,
  })),
};
await writeFile(path.join(root, 'data/index.json'), JSON.stringify(index, null, 2) + '\n');

const degrees = index.bands.map((b) => b.degree);
const edgeCount = seen.size;
console.log(
  `✓ ${merged.size} 支乐队 / ${edgeCount} 条关系` +
    (isolated.length ? `（丢掉 ${isolated.length} 个孤岛）` : '') +
    `\n  每队关系数：最少 ${Math.min(...degrees)}，最多 ${Math.max(...degrees)}，` +
    `平均 ${(degrees.reduce((a, b) => a + b, 0) / degrees.length).toFixed(1)}`
);
