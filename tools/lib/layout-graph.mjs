import { UndirectedGraph } from 'graphology';
import { connectedComponents } from 'graphology-components';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';

const TYPE_WEIGHT = {
  member: 2.4,
  feud: 2,
  guest: 1.6,
  influence: 1.15,
  scene: 0.75,
};
const LABEL_HEIGHT = 22;
const LABEL_MARGIN = 10;
const COMPONENT_GAP = 90;
const GOLDEN_ANGLE = 2.399963229728653;
const DEFAULT_OPTIONS = {
  adjustSizes: false,
  collisionRatio: 0.46,
  fa2Scaling: 4.6,
  linLogMode: false,
  noverlap: true,
};

function hash(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function labelRadius(width) {
  return Math.hypot(width / 2 + LABEL_MARGIN / 2, LABEL_HEIGHT / 2 + LABEL_MARGIN / 2);
}

function buildTopology(nodes, edges, options) {
  const graph = new UndirectedGraph({ allowSelfLoops: false });
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    graph.addNode(node.id, {
      labelWidth: node.labelWidth,
      size: labelRadius(node.labelWidth) * options.collisionRatio,
      degree: node.degree,
    });
  }
  for (const edge of [...edges].sort((a, b) =>
    `${a.from}|${a.to}|${a.type}`.localeCompare(`${b.from}|${b.to}|${b.type}`)
  )) {
    if (edge.from === edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    const weight = TYPE_WEIGHT[edge.type] ?? 1;
    const existing = graph.edge(edge.from, edge.to);
    if (existing) {
      graph.updateEdgeAttribute(existing, 'weight', (value = 0) => value + weight);
    } else {
      graph.addUndirectedEdge(edge.from, edge.to, { weight });
    }
  }
  return graph;
}

function componentGraph(topology, ids) {
  const graph = new UndirectedGraph({ allowSelfLoops: false });
  const included = new Set(ids);
  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    const source = topology.getNodeAttributes(id);
    const index = graph.order;
    const angle = index * GOLDEN_ANGLE + (hash(id) % 4096) / 4096 * 0.08;
    const radius = 18 * Math.sqrt(index + 1);
    graph.addNode(id, {
      ...source,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  topology.forEachEdge((key, attributes, from, to) => {
    if (!included.has(from) || !included.has(to)) return;
    graph.addUndirectedEdge(from, to, { weight: attributes.weight });
  });
  return graph;
}

function runComponentLayout(graph, options) {
  if (graph.order <= 1) return;
  const inferred = forceAtlas2.inferSettings(graph);
  forceAtlas2.assign(graph, {
    iterations: graph.order > 500 ? 1400 : graph.order > 100 ? 1000 : 600,
    getEdgeWeight: 'weight',
    settings: {
      ...inferred,
      adjustSizes: options.adjustSizes,
      barnesHutOptimize: graph.order > 200,
      barnesHutTheta: 0.5,
      edgeWeightInfluence: 1,
      gravity: 0.08,
      linLogMode: options.linLogMode,
      outboundAttractionDistribution: false,
      scalingRatio: options.fa2Scaling,
      slowDown: graph.order > 500 ? 10 : 7,
      strongGravityMode: true,
    },
  });
  if (options.noverlap) {
    // Gephi 也建议把防重叠放在主布局之后单独收尾，避免它破坏社群形成过程。
    // graphology-noverlap 在两个点完全重合时会调用 Math.random 抖开它们；
    // 暂时换成由节点 id 派生的 PRNG，保证同一份数据重复构建坐标逐字节一致。
    let randomState = hash([...graph.nodes()].sort().join('|')) || 1;
    const seededRandom = () => {
      randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
      randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState);
      return ((randomState ^ (randomState >>> 14)) >>> 0) / 4294967296;
    };
    const nativeRandom = Math.random;
    Math.random = seededRandom;
    try {
      noverlap.assign(graph, {
        maxIterations: graph.order > 500 ? 1200 : 700,
        settings: {
          expansion: 1.08,
          gridSize: 24,
          margin: LABEL_MARGIN * options.collisionRatio,
          ratio: 1,
          speed: 2,
        },
      });
    } finally {
      Math.random = nativeRandom;
    }
  }
}

function boundsOf(graph) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  graph.forEachNode((id, attributes) => {
    const halfWidth = attributes.labelWidth / 2 + LABEL_MARGIN;
    const halfHeight = LABEL_HEIGHT / 2 + LABEL_MARGIN;
    minX = Math.min(minX, attributes.x - halfWidth);
    maxX = Math.max(maxX, attributes.x + halfWidth);
    minY = Math.min(minY, attributes.y - halfHeight);
    maxY = Math.max(maxY, attributes.y + halfHeight);
  });
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function overlaps(a, b, gap = COMPONENT_GAP) {
  return !(
    a.maxX + gap <= b.minX ||
    b.maxX + gap <= a.minX ||
    a.maxY + gap <= b.minY ||
    b.maxY + gap <= a.minY
  );
}

function placeComponents(components) {
  const placed = [];
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const own = boundsOf(component.graph);
    let centerX = 0;
    let centerY = 0;
    if (index > 0) {
      let found = false;
      const phase = (hash(component.ids[0]) % 6283) / 1000;
      for (let attempt = 1; attempt < 20000; attempt += 1) {
        const angle = phase + attempt * 0.43;
        const radius = 28 * Math.sqrt(attempt);
        centerX = Math.cos(angle) * radius;
        centerY = Math.sin(angle) * radius;
        const candidate = {
          minX: centerX - own.width / 2,
          maxX: centerX + own.width / 2,
          minY: centerY - own.height / 2,
          maxY: centerY + own.height / 2,
        };
        if (placed.every((box) => !overlaps(candidate, box))) {
          found = true;
          break;
        }
      }
      if (!found) throw new Error(`无法为关系分量 ${component.ids[0]} 找到位置`);
    }
    const shiftX = centerX - (own.minX + own.maxX) / 2;
    const shiftY = centerY - (own.minY + own.maxY) / 2;
    component.graph.updateEachNodeAttributes((id, attributes) => ({
      ...attributes,
      x: attributes.x + shiftX,
      y: attributes.y + shiftY,
    }));
    const box = boundsOf(component.graph);
    placed.push(box);
  }
}

function rectangularOverlapCount(positions) {
  const points = [...positions.values()];
  let count = 0;
  const cellSize = 220;
  const grid = new Map();
  for (const point of points) {
    const gx = Math.floor(point.x / cellSize);
    const gy = Math.floor(point.y / cellSize);
    for (let x = gx - 1; x <= gx + 1; x += 1) {
      for (let y = gy - 1; y <= gy + 1; y += 1) {
        for (const other of grid.get(`${x},${y}`) || []) {
          if (
            Math.abs(point.x - other.x) <
              (point.labelWidth + other.labelWidth) / 2 + LABEL_MARGIN &&
            Math.abs(point.y - other.y) < LABEL_HEIGHT + LABEL_MARGIN
          ) count += 1;
        }
      }
    }
    const key = `${gx},${gy}`;
    const bucket = grid.get(key) || [];
    bucket.push(point);
    grid.set(key, bucket);
  }
  return count;
}

export function layoutGraphOffline(nodes, edges, suppliedOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  const started = performance.now();
  const topology = buildTopology(nodes, edges, options);
  const componentIds = connectedComponents(topology).sort((a, b) =>
    b.length - a.length || a[0].localeCompare(b[0])
  );
  const components = componentIds.map((ids) => {
    const graph = componentGraph(topology, ids);
    runComponentLayout(graph, options);
    return { ids, graph };
  });
  placeComponents(components);

  const positions = new Map();
  for (const component of components) {
    component.graph.forEachNode((id, attributes) => {
      positions.set(id, {
        x: attributes.x,
        y: attributes.y,
        labelWidth: attributes.labelWidth,
      });
    });
  }
  return {
    positions,
    milliseconds: Math.round(performance.now() - started),
    metadata: {
      algorithm: 'graphology-forceatlas2+noverlap',
      deterministic: true,
      settings: {
        adjustSizes: options.adjustSizes,
        collisionRatio: options.collisionRatio,
        fa2Scaling: options.fa2Scaling,
        linLogMode: options.linLogMode,
      },
      components: components.length,
      largestComponent: components[0]?.ids.length ?? 0,
      overlaps: rectangularOverlapCount(positions),
    },
  };
}
