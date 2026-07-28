const COLORS = {
  'east-asia': '#ef9f5a',
  western: '#79aefc',
  other: '#a891d7',
  unknown: '#737b87',
};
const EDGE_COLORS = {
  member: '#58a6ff',
  guest: '#45c58c',
  influence: '#b98cff',
  feud: '#ff6b5e',
  scene: '#d9ac5a',
};
const STAGES = [
  { scale: 1, count: 9 },
  { scale: 0.68, count: 40 },
  { scale: 0.42, count: 160 },
  { scale: 0.21, count: Infinity },
];
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_PIXEL_RATIO = 2;
const MAP_POPULAR_LISTEN_FLOOR = 1000;
const GRAPH_VERSION = 'fc240e768f';

const hash = (text) => {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const textUnits = (text) =>
  [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 1 : 0.62), 0);

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
}

export function createNetworkMap({ canvas, onChoose, popularOnly: initialPopularOnly = true, onPopularChange }) {
  let graph;
  let nodes;
  let positions;
  let links;
  let adjacency;
  let rankedHops = [];
  let primaryIds = [];
  let allowedIds = [];
  let stageViews = [];
  let activeStage = 0;
  let wantedStage = 0;
  let pixelRatio = 1;
  let viewportWidth = 1;
  let viewportHeight = 1;
  let focusId;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let drag = null;
  let pinch = null;
  let popularOnly = initialPopularOnly;
  let renderFrame = 0;
  const pointers = new Map();
  const ctx = canvas.getContext('2d', { alpha: false });
  const surface = canvas.parentElement;
  const stats = document.getElementById('map-stats');
  const picker = document.getElementById('map-band-select');
  const popularToggle = document.getElementById('map-popular-toggle');

  async function load() {
    if (graph) return;
    const embedded = globalThis.BAND_ATLAS_DATA?.graph;
    if (embedded) {
      graph = embedded;
    } else {
      const response = await fetch(`data/graph.json?v=${GRAPH_VERSION}`);
      if (!response.ok) throw new Error(`地图数据加载失败（HTTP ${response.status}）`);
      graph = await response.json();
    }
    if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
      graph = null;
      throw new Error('地图数据格式错误');
    }
    nodes = new Map(
      graph.nodes.map((node) => [
        node.id,
        {
          ...node,
          labelWidth: node.labelWidth ?? clamp(textUnits(node.name) * 11 + 18, 42, 188),
        },
      ])
    );
    positions = new Map(
      [...nodes.values()].map((node) => [
        node.id,
        { node, x: node.x ?? 0, y: node.y ?? 0 },
      ])
    );
    links = graph.edges
      .map((edge) => ({ edge, a: positions.get(edge.from), b: positions.get(edge.to) }))
      .filter(({ a, b }) => a && b);
    adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const { a, b } of links) {
      adjacency.get(a.node.id).push(b.node.id);
      adjacency.get(b.node.id).push(a.node.id);
    }
  }

  function prepareFocus(id) {
    const allowed = (nodeId) =>
      !popularOnly ||
      nodeId === id ||
      nodes.get(nodeId)?.regionalFeatured ||
      (nodes.get(nodeId)?.listens ?? 0) >= MAP_POPULAR_LISTEN_FLOOR;
    if (picker) {
      const fragment = document.createDocumentFragment();
      for (const node of [...nodes.values()]
        .filter((node) => allowed(node.id))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
        const option = document.createElement('option');
        option.value = node.id;
        option.textContent = `${node.name}${node.region === 'east-asia' ? ' · 东亚' : ''}`;
        fragment.append(option);
      }
      picker.replaceChildren(fragment);
    }
    const hops = new Map([[id, 0]]);
    const queue = [id];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const from = queue[cursor];
      const depth = hops.get(from) + 1;
      for (const to of adjacency.get(from) || []) {
        if (hops.has(to)) continue;
        hops.set(to, depth);
        queue.push(to);
      }
    }
    rankedHops = [...hops].sort(([a, hopA], [b, hopB]) => {
      if (hopA !== hopB) return hopA - hopB;
      return (nodes.get(b)?.degree || 0) - (nodes.get(a)?.degree || 0) || hash(a) - hash(b);
    });

    primaryIds = [...(adjacency.get(id) || [])].filter(allowed).sort((a, b) => {
      const degreeDifference = (nodes.get(b)?.degree || 0) - (nodes.get(a)?.degree || 0);
      return degreeDifference || hash(a) - hash(b);
    });
    allowedIds = [...nodes.keys()].filter(allowed);

    stageViews = STAGES.map((stage, index) => {
      const ids =
        index === 0
          ? [focusId, ...primaryIds.slice(0, 8)]
          : index === STAGES.length - 1
            ? [...nodes.keys()].filter(allowed)
            : rankedHops.filter(([nodeId]) => allowed(nodeId)).slice(0, stage.count).map(([nodeId]) => nodeId);
      const visible = new Set(ids);
      return {
        visible,
        points: [...positions.values()]
          .filter((point) => visible.has(point.node.id))
          .sort((a, b) => (a.node.id === focusId ? 1 : 0) - (b.node.id === focusId ? 1 : 0)),
        links: links.filter(({ a, b }) => visible.has(a.node.id) && visible.has(b.node.id)),
      };
    });
  }

  function prepareViewportStages(screenX = viewportWidth / 2, screenY = viewportHeight / 2) {
    const centerX = (screenX - viewportWidth / 2 - offsetX) / scale;
    const centerY = (screenY - viewportHeight / 2 - offsetY) / scale;
    const nearestIds = allowedIds
      .map((id) => {
        const point = positions.get(id);
        const dx = point.x - centerX;
        const dy = point.y - centerY;
        return { id, distance: dx * dx + dy * dy };
      })
      .sort((a, b) => a.distance - b.distance || hash(a.id) - hash(b.id))
      .map(({ id }) => id);

    stageViews = STAGES.map((stage, index) => {
      const ids =
        index === STAGES.length - 1
          ? allowedIds
          : nearestIds.slice(0, stage.count);
      const visible = new Set(ids);
      return {
        visible,
        points: [...positions.values()]
          .filter((point) => visible.has(point.node.id))
          .sort((a, b) => (a.node.id === focusId ? 1 : 0) - (b.node.id === focusId ? 1 : 0)),
        links: links.filter(({ a, b }) => visible.has(a.node.id) && visible.has(b.node.id)),
      };
    });
  }

  function stageForScale(value) {
    if (value >= 0.82) return 0;
    if (value >= 0.55) return 1;
    if (value >= 0.32) return 2;
    return 3;
  }

  function labelMetrics(node, renderScale) {
    const fontScreen = clamp(11 * Math.sqrt(renderScale), 7.2, 12);
    return {
      fontScreen,
      widthScreen: node.labelWidth * (fontScreen / 11),
      heightScreen: clamp(22 * Math.sqrt(renderScale), 14, 25),
    };
  }

  function boundaryDistance(metrics, ux, uy) {
    const halfWidth = metrics.widthScreen / 2;
    const halfHeight = metrics.heightScreen / 2;
    const tx = Math.abs(ux) < 0.0001 ? Infinity : halfWidth / Math.abs(ux);
    const ty = Math.abs(uy) < 0.0001 ? Infinity : halfHeight / Math.abs(uy);
    return Math.min(tx, ty);
  }

  function render(stageIndex = activeStage) {
    renderFrame = 0;
    const stage = STAGES[stageIndex];
    const view = stageViews[stageIndex];
    if (!view) return;
    activeStage = stageIndex;
    const zoomRatio = scale / stage.scale;
    const display = new Map(
      view.points.map((point) => [
        point.node.id,
        {
          ...point,
          screenX: viewportWidth / 2 + offsetX + point.x * scale,
          screenY: viewportHeight / 2 + offsetY + point.y * scale,
        },
      ])
    );
    const displayMetrics = (node) => {
      const metrics = labelMetrics(node, stage.scale);
      return {
        fontScreen: metrics.fontScreen * zoomRatio,
        widthScreen: metrics.widthScreen * zoomRatio,
        heightScreen: metrics.heightScreen * zoomRatio,
      };
    };

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.fillStyle = '#0d1014';
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);
    const linkGroups = new Map();
    for (const link of view.links) {
      const weightBucket = Math.round(clamp(link.edge.weight ?? 0.5, 0, 1) * 3);
      const key = `${link.edge.type}:${weightBucket}`;
      const group = linkGroups.get(key) || [];
      group.push(link);
      linkGroups.set(key, group);
    }
    for (const [key, group] of linkGroups) {
      const [type, bucketText] = key.split(':');
      const weightBucket = Number(bucketText);
      ctx.strokeStyle = EDGE_COLORS[type] || '#96a4b4';
      ctx.globalAlpha = type === 'scene' ? 0.42 : 0.56;
      ctx.lineWidth = (0.75 + weightBucket * 0.34) * zoomRatio;
      ctx.setLineDash(
        type === 'feud'
          ? [6 * zoomRatio, 4 * zoomRatio]
          : type === 'scene'
            ? [1.5 * zoomRatio, 4 * zoomRatio]
            : []
      );
      ctx.beginPath();
      for (const { a, b } of group) {
        const ap = display.get(a.node.id);
        const bp = display.get(b.node.id);
        const dx = bp.screenX - ap.screenX;
        const dy = bp.screenY - ap.screenY;
        const distance = Math.hypot(dx, dy);
        if (!distance) continue;
        const margin = 40;
        if (
          Math.max(ap.screenX, bp.screenX) < -margin ||
          Math.min(ap.screenX, bp.screenX) > viewportWidth + margin ||
          Math.max(ap.screenY, bp.screenY) < -margin ||
          Math.min(ap.screenY, bp.screenY) > viewportHeight + margin
        ) continue;
        const ux = dx / distance;
        const uy = dy / distance;
        const from = boundaryDistance(displayMetrics(a.node), ux, uy);
        const to = boundaryDistance(displayMetrics(b.node), ux, uy);
        if (distance <= from + to) continue;
        ctx.moveTo(ap.screenX + ux * from, ap.screenY + uy * from);
        ctx.lineTo(bp.screenX - ux * to, bp.screenY - uy * to);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    for (const point of view.points) {
      const at = display.get(point.node.id);
      const metrics = displayMetrics(point.node);
      if (
        at.screenX + metrics.widthScreen / 2 < -4 ||
        at.screenX - metrics.widthScreen / 2 > viewportWidth + 4 ||
        at.screenY + metrics.heightScreen / 2 < -4 ||
        at.screenY - metrics.heightScreen / 2 > viewportHeight + 4
      ) continue;
      const selected = point.node.id === focusId;
      const color = COLORS[point.node.region] || COLORS.unknown;
      roundedRect(
        ctx,
        at.screenX - metrics.widthScreen / 2,
        at.screenY - metrics.heightScreen / 2,
        metrics.widthScreen,
        metrics.heightScreen,
        8 * zoomRatio
      );
      ctx.fillStyle = selected ? color : 'rgba(19,24,31,.94)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#f3efe4' : color;
      ctx.lineWidth = (selected ? 2.2 : 1.15) * zoomRatio;
      ctx.stroke();
      ctx.fillStyle = selected ? '#101419' : '#ece8df';
      ctx.font = `${selected ? 650 : 520} ${metrics.fontScreen}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        point.node.name,
        at.screenX,
        at.screenY,
        metrics.widthScreen - 10 * zoomRatio
      );
    }
    if (stats) {
      const shown = view.visible.size;
      stats.textContent = `阶段 ${stageIndex + 1}/4 · 显示 ${shown} / ${nodes.size}`;
      if (popularOnly) stats.textContent += ` · 隐藏冷门`;
    }
    if (picker) picker.value = focusId;
  }

  function sizeCanvas() {
    viewportWidth = Math.max(1, surface.clientWidth);
    viewportHeight = Math.max(1, surface.clientHeight);
    pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      MAX_PIXEL_RATIO,
      Math.sqrt(MAX_CANVAS_PIXELS / (viewportWidth * viewportHeight))
    );
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.position = 'absolute';
    canvas.style.transform = 'none';
    canvas.width = Math.round(viewportWidth * pixelRatio);
    canvas.height = Math.round(viewportHeight * pixelRatio);
  }

  function requestRender() {
    if (!renderFrame) renderFrame = requestAnimationFrame(() => render(activeStage));
  }

  function chooseStage(screenX, screenY) {
    wantedStage = stageForScale(scale);
    if (wantedStage < activeStage) prepareViewportStages(screenX, screenY);
    activeStage = wantedStage;
    requestRender();
  }

  async function preloadStages() {
    sizeCanvas();
    activeStage = stageForScale(scale);
    render(activeStage);
  }

  function screenPoint(event) {
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function zoomAt(nextScale, screenX, screenY) {
    const worldX = (screenX - viewportWidth / 2 - offsetX) / scale;
    const worldY = (screenY - viewportHeight / 2 - offsetY) / scale;
    scale = clamp(nextScale, 0.14, 1.5);
    offsetX = screenX - viewportWidth / 2 - worldX * scale;
    offsetY = screenY - viewportHeight / 2 - worldY * scale;
  }

  function hit(screenX, screenY) {
    const stageScale = STAGES[activeStage].scale;
    for (const point of [...stageViews[activeStage].points].reverse()) {
      const metrics = labelMetrics(point.node, stageScale);
      const x = viewportWidth / 2 + offsetX + point.x * scale;
      const y = viewportHeight / 2 + offsetY + point.y * scale;
      const sizeRatio = scale / stageScale;
      if (
        Math.abs(screenX - x) <= metrics.widthScreen * sizeRatio / 2 + 4 &&
        Math.abs(screenY - y) <= metrics.heightScreen * sizeRatio / 2 + 4
      ) return point.node;
    }
    return null;
  }

  function beginPointer(event) {
    const point = screenPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 1) drag = { ...point, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      if (drag) drag.moved = true;
    }
  }

  function adoptPointers(entries) {
    pointers.clear();
    const rect = surface.getBoundingClientRect();
    for (const entry of entries) {
      pointers.set(entry.id, { x: entry.clientX - rect.left, y: entry.clientY - rect.top });
    }
    const values = [...pointers.values()];
    drag = values.length ? { ...values[0], moved: values.length > 1 } : null;
    if (values.length === 2) {
      const [a, b] = values;
      pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
    }
  }

  function movePointer(event) {
    if (!pointers.has(event.pointerId)) return;
    const point = screenPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (pinch?.distance) zoomAt(scale * distance / pinch.distance, pinch.midX, pinch.midY);
      offsetX += midX - (pinch?.midX ?? midX);
      offsetY += midY - (pinch?.midY ?? midY);
      pinch = { distance, midX, midY };
      if (drag) drag.moved = true;
      chooseStage(midX, midY);
      return;
    }
    if (drag) {
      offsetX += point.x - drag.x;
      offsetY += point.y - drag.y;
      drag.x = point.x;
      drag.y = point.y;
      drag.moved = true;
      requestRender();
    }
  }

  function endPointer(event) {
    const point = screenPoint(event);
    pointers.delete(event.pointerId);
    let chosen = null;
    if (!pointers.size && drag && !drag.moved) chosen = hit(point.x, point.y);
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      drag = { ...remaining, moved: true };
    } else if (!pointers.size) {
      drag = null;
    }
    pinch = null;
    if (chosen) onChoose(chosen.id);
  }

  surface.addEventListener('pointerdown', (event) => {
    if (event.target.closest?.('.network-map__hud')) return;
    surface.setPointerCapture(event.pointerId);
    beginPointer(event);
  });
  surface.addEventListener('pointermove', movePointer);
  surface.addEventListener('pointerup', endPointer);
  surface.addEventListener('pointercancel', endPointer);
  surface.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const point = screenPoint(event);
      zoomAt(scale * (event.deltaY > 0 ? 0.94 : 1.065), point.x, point.y);
      chooseStage(point.x, point.y);
    },
    { passive: false }
  );
  canvas.addEventListener('keydown', (event) => {
    const move = 64;
    if (event.key === 'ArrowLeft') offsetX += move;
    else if (event.key === 'ArrowRight') offsetX -= move;
    else if (event.key === 'ArrowUp') offsetY += move;
    else if (event.key === 'ArrowDown') offsetY -= move;
    else if (event.key === '+' || event.key === '=') {
      zoomAt(scale * 1.15, viewportWidth / 2, viewportHeight / 2);
      chooseStage(viewportWidth / 2, viewportHeight / 2);
      event.preventDefault();
      return;
    } else if (event.key === '-' || event.key === '_') {
      zoomAt(scale / 1.15, viewportWidth / 2, viewportHeight / 2);
      chooseStage(viewportWidth / 2, viewportHeight / 2);
      event.preventDefault();
      return;
    } else if (event.key === 'Escape') {
      document.getElementById('map-close')?.click();
      return;
    } else {
      return;
    }
    requestRender();
    event.preventDefault();
  });
  picker?.addEventListener('change', () => {
    if (picker.value) onChoose(picker.value);
  });
  popularToggle?.addEventListener('click', async () => {
    await setPopularOnly(!popularOnly);
    onPopularChange?.(popularOnly);
    canvas.focus();
  });

  async function setPopularOnly(enabled, { rebuild = true } = {}) {
    const next = Boolean(enabled);
    const changed = next !== popularOnly;
    popularOnly = next;
    popularToggle?.setAttribute('aria-pressed', String(popularOnly));
    if (popularToggle) popularToggle.textContent = `隐藏冷门：${popularOnly ? '开' : '关'}`;
    if (!focusId || !changed || !rebuild) return;
    prepareFocus(focusId);
    wantedStage = stageForScale(scale);
    await preloadStages();
  }

  return {
    async open(id) {
      await load();
      focusId = id;
      prepareFocus(id);
      scale = 1;
      const focus = positions.get(id);
      offsetX = -focus.x;
      offsetY = -focus.y;
      wantedStage = 0;
      await preloadStages();
    },
    resize() {
      if (focusId) preloadStages();
    },
    setPopularOnly,
    adoptPointers,
    moveAdoptedPointer: movePointer,
    endAdoptedPointer: endPointer,
    cancelPointers() {
      pointers.clear();
      drag = null;
      pinch = null;
    },
  };
}
