#!/usr/bin/env node
/**
 * 把 data/source/*.json 的单向边展开成每支乐队一份的 JSON。
 * M1 阶段 MusicBrainz 管线只需产出同样形状的 source 文件即可接上。
 *
 *   node tools/build-data.mjs
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'data/source/scene-jrock.json');
const OUT_DIR = path.join(root, 'data/bands');

const TYPES = new Set(['member', 'guest', 'influence', 'feud', 'scene']);

const src = JSON.parse(await readFile(SOURCE, 'utf8'));
const bands = new Map(src.bands.map((b) => [b.id, b]));

const problems = [];
const adjacency = new Map(src.bands.map((b) => [b.id, []]));

for (const [i, e] of src.edges.entries()) {
  const where = `edges[${i}] ${e.from} → ${e.to}`;
  if (!bands.has(e.from)) problems.push(`${where}：from 指向不存在的乐队`);
  if (!bands.has(e.to)) problems.push(`${where}：to 指向不存在的乐队`);
  if (!TYPES.has(e.type)) problems.push(`${where}：未知关系类型 "${e.type}"`);
  if (e.from === e.to) problems.push(`${where}：自环`);
  if (!bands.has(e.from) || !bands.has(e.to)) continue;

  // 一条来源边 → 两侧各一条展示边，反向时换用 detailRev 的措辞。
  adjacency.get(e.from).push(makeEdge(e, e.to, e.detail));
  adjacency.get(e.to).push(makeEdge(e, e.from, e.detailRev ?? e.detail));
}

function makeEdge(e, otherId, detail) {
  const other = bands.get(otherId);
  return {
    to: otherId,
    toName: other.name,
    toArea: other.area,
    toYears: other.years,
    type: e.type,
    label: e.label,
    detail,
    year: e.year ?? null,
    weight: e.weight ?? 0.5,
  };
}

for (const [id, edges] of adjacency) {
  // 权重降序，同权重按 id 保证构建结果稳定
  edges.sort((a, b) => b.weight - a.weight || a.to.localeCompare(b.to));
  if (edges.length === 0) problems.push(`${id}：没有任何关系边，将成为孤岛`);
}

if (problems.length) {
  console.error('数据校验未通过：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

for (const band of src.bands) {
  const edges = adjacency.get(band.id);
  const doc = {
    ...band,
    links: {
      musicbrainz: `https://musicbrainz.org/search?query=${encodeURIComponent(band.name)}&type=artist`,
    },
    edges,
  };
  await writeFile(path.join(OUT_DIR, `${band.id}.json`), JSON.stringify(doc, null, 2) + '\n');
}

const index = {
  scene: src.scene,
  note: src.note,
  generatedAt: new Date().toISOString().slice(0, 10),
  bands: src.bands.map((b) => ({
    id: b.id,
    name: b.name,
    area: b.area,
    years: b.years,
    degree: adjacency.get(b.id).length,
  })),
};
await writeFile(path.join(root, 'data/index.json'), JSON.stringify(index, null, 2) + '\n');

const degrees = index.bands.map((b) => b.degree);
console.log(
  `✓ ${src.bands.length} 支乐队 / ${src.edges.length} 条来源边（展开为 ${src.edges.length * 2} 条展示边）\n` +
    `  每队关系数：最少 ${Math.min(...degrees)}，最多 ${Math.max(...degrees)}，` +
    `平均 ${(degrees.reduce((a, b) => a + b, 0) / degrees.length).toFixed(1)}`
);
