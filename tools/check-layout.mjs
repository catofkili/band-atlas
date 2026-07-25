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
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return 0;
  const ux = dx / distance;
  const uy = dy / distance;
  const boundaryDistance = (node) => {
    const horizontal = Math.abs(ux) < 0.00001
      ? Infinity
      : node.labelWidth / 2 / Math.abs(ux);
    const vertical = Math.abs(uy) < 0.00001
      ? Infinity
      : 11 / Math.abs(uy);
    return Math.min(horizontal, vertical);
  };
  const visibleLine = Math.max(0, distance - boundaryDistance(a) - boundaryDistance(b));
  return visibleLine / ((a.labelWidth + b.labelWidth) / 2);
}).sort((a, b) => a - b);
const percentile = (value) => edgeRatios[Math.floor((edgeRatios.length - 1) * value)];
const medianEdgeRatio = percentile(0.5);
const p90EdgeRatio = percentile(0.9);

// 这些上限贴近当前经过人工查看的基线；以后布局参数一旦明显退化就立即失败，
// 不再用“允许三千处重叠”这种几乎拦不住回归的宽阈值。
if (overlaps > 2360) throw new Error(`标签重叠过多：${overlaps}`);
if (medianEdgeRatio > 1.02) throw new Error(`可见关系线中位长度过长：${medianEdgeRatio.toFixed(2)}`);
if (p90EdgeRatio > 2.9) throw new Error(`可见关系线 P90 长度过长：${p90EdgeRatio.toFixed(2)}`);

console.log(
  `✓ 离线坐标 ${nodes.size} 个，标签重叠 ${overlaps}，` +
  `可见线段/气泡宽度 P50 ${medianEdgeRatio.toFixed(2)}，P90 ${p90EdgeRatio.toFixed(2)}`
);
