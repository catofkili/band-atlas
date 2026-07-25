#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graph = JSON.parse(await readFile(path.join(root, 'data/graph.json'), 'utf8'));
const nodes = new Map(graph.nodes.map((node) => [node.id, node]));

for (const node of nodes.values()) {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
    throw new Error(`${node.id} 缺少有效的离线坐标`);
  }
}

let overlaps = 0;
const points = [...nodes.values()];
for (let i = 0; i < points.length; i += 1) {
  for (let j = i + 1; j < points.length; j += 1) {
    const a = points[i];
    const b = points[j];
    if (
      Math.abs(a.x - b.x) < (a.labelWidth + b.labelWidth) / 2 + 10 &&
      Math.abs(a.y - b.y) < 32
    ) overlaps += 1;
  }
}

const edgeRatios = graph.edges.map((edge) => {
  const a = nodes.get(edge.from);
  const b = nodes.get(edge.to);
  return Math.hypot(a.x - b.x, a.y - b.y) / ((a.labelWidth + b.labelWidth) / 2);
}).sort((a, b) => a - b);
const percentile = (value) => edgeRatios[Math.floor((edgeRatios.length - 1) * value)];
const medianEdgeRatio = percentile(0.5);

if (overlaps > 3000) throw new Error(`标签重叠过多：${overlaps}`);
if (medianEdgeRatio > 1.8) throw new Error(`关系线中位长度过长：${medianEdgeRatio.toFixed(2)}`);

console.log(
  `✓ 离线坐标 ${nodes.size} 个，标签重叠 ${overlaps}，` +
  `关系线/气泡宽度 P50 ${medianEdgeRatio.toFixed(2)}，P90 ${percentile(0.9).toFixed(2)}`
);
