const COLORS = {
  'east-asia': '#ef9f5a',
  western: '#79aefc',
  other: '#a891d7',
  unknown: '#737b87',
};

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

export function createNetworkMap({ canvas, onChoose }) {
  let graph;
  let nodes;
  let positions;
  let links;
  let adjacency;
  let hops;
  let rankedHops = [];
  let primaryIds = [];
  let localPositions = new Map();
  let viewCache = new Map();
  let metricsCache = new Map();
  let focusId;
  let followFocus = true;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let pixelRatio = 1;
  let drag = null;
  let pinch = null;
  let drawFrame = 0;
  let transformFrame = 0;
  let gestureBase = null;
  const pointers = new Map();
  const ctx = canvas.getContext('2d', { alpha: false });
  const stats = document.getElementById('map-stats');

  async function load() {
    if (graph) return;
    graph = await fetch('data/graph.json').then((response) => response.json());
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

  function desiredLinkLength(a, b) {
    return (a.node.labelWidth + b.node.labelWidth) / 2 +
      Math.min(46, Math.max(a.node.labelWidth, b.node.labelWidth) * 0.48);
  }

  function measureHops(id) {
    hops = new Map([[id, 0]]);
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

    const focus = positions.get(id);
    primaryIds = [...(adjacency.get(id) || [])].sort((a, b) => {
      const degreeDifference = (nodes.get(b)?.degree || 0) - (nodes.get(a)?.degree || 0);
      return degreeDifference || hash(a) - hash(b);
    });
    const compactAngles = [
      -Math.PI / 2,
      Math.PI / 2,
      -Math.PI * 3 / 4,
      -Math.PI / 4,
      Math.PI * 3 / 4,
      Math.PI / 4,
      Math.PI,
      0,
    ];
    const compactOrder = [...primaryIds.slice(0, 8)]
      .sort((a, b) => nodes.get(b).labelWidth - nodes.get(a).labelWidth);
    const compactAngle = new Map(
      compactOrder.map((neighborId, index) => [neighborId, compactAngles[index]])
    );
    localPositions = new Map();
    primaryIds.forEach((neighborId, index) => {
      const neighbor = positions.get(neighborId);
      localPositions.set(neighborId, {
        index,
        radius: desiredLinkLength(focus, neighbor) * (index % 2 ? 1.24 : 1),
        compactAngle: compactAngle.get(neighborId),
      });
    });
    viewCache = new Map();
  }

  function visibilitySpec() {
    if (scale >= 0.82) return { key: 'near', ids: [focusId, ...primaryIds.slice(0, 8)] };
    const depth = scale >= 0.48 ? 2 : scale >= 0.27 ? 3 : Infinity;
    const rawBudget = scale >= 0.48
      ? 20 + (0.82 - scale) * 100
      : scale >= 0.27
        ? 55 + (0.48 - scale) * 350
        : 130 + (0.27 - scale) * 7000;
    // 每四支才切一次层级，细小手势不会反复重建可见集合。
    const budget = Math.max(8, Math.ceil(rawBudget / 4) * 4);
    return { key: `${depth}:${budget}`, depth, budget };
  }

  function viewData() {
    const spec = visibilitySpec();
    const cached = viewCache.get(spec.key);
    if (cached) return cached;
    const ids = spec.ids ?? rankedHops
      .filter(([, hop]) => hop <= spec.depth)
      .slice(0, spec.budget)
      .map(([id]) => id);
    const visible = new Set(ids);
    const points = [...positions.values()]
      .filter((point) => visible.has(point.node.id))
      .sort((a, b) => (a.node.id === focusId ? 1 : 0) - (b.node.id === focusId ? 1 : 0));
    const visibleLinks = links.filter(
      ({ a, b }) => visible.has(a.node.id) && visible.has(b.node.id)
    );
    const data = { visible, points, links: visibleLinks };
    viewCache.set(spec.key, data);
    return data;
  }

  function labelMetrics(node) {
    const cached = metricsCache.get(node.id);
    if (cached) return cached;
    const fontScreen = clamp(11 * Math.sqrt(scale), 7.2, 12);
    const metrics = {
      fontScreen,
      widthScreen: node.labelWidth * (fontScreen / 11),
      heightScreen: clamp(22 * Math.sqrt(scale), 14, 25),
    };
    metricsCache.set(node.id, metrics);
    return metrics;
  }

  function boundaryDistance(metrics, ux, uy) {
    const halfWidth = metrics.widthScreen / scale / 2;
    const halfHeight = metrics.heightScreen / scale / 2;
    const tx = Math.abs(ux) < 0.0001 ? Infinity : halfWidth / Math.abs(ux);
    const ty = Math.abs(uy) < 0.0001 ? Infinity : halfHeight / Math.abs(uy);
    return Math.min(tx, ty);
  }

  function displayPosition(point) {
    const local = localPositions.get(point.node.id);
    if (!local) return point;
    const focus = positions.get(focusId);
    const count = scale >= 0.82 ? Math.min(8, primaryIds.length) : primaryIds.length;
    const angle = scale >= 0.82
      ? local.compactAngle
      : -Math.PI / 2 + (local.index / Math.max(1, count)) * Math.PI * 2;
    const metrics = labelMetrics(point.node);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let radiusScreen = local.radius * scale;
    if (Math.abs(cos) > 0.001) {
      radiusScreen = Math.min(
        radiusScreen,
        (canvas.clientWidth / 2 - metrics.widthScreen / 2 - 14) / Math.abs(cos)
      );
    }
    if (Math.abs(sin) > 0.001) {
      radiusScreen = Math.min(
        radiusScreen,
        (canvas.clientHeight / 2 - metrics.heightScreen / 2 - 68) / Math.abs(sin)
      );
    }
    const focusMetrics = labelMetrics(focus.node);
    const minimumScreen = (
      boundaryDistance(focusMetrics, cos, sin) +
      boundaryDistance(metrics, cos, sin)
    ) * scale + 12;
    const radius = Math.max(minimumScreen, radiusScreen) / scale;
    return { x: focus.x + cos * radius, y: focus.y + sin * radius };
  }

  function draw() {
    drawFrame = 0;
    if (!graph || !canvas.width) return;
    metricsCache = new Map();
    const width = canvas.width / pixelRatio;
    const height = canvas.height / pixelRatio;
    if (followFocus) {
      const focus = positions.get(focusId);
      if (focus) {
        offsetX = -focus.x * scale;
        offsetY = -focus.y * scale;
      }
    }
    const view = viewData();
    const display = new Map(view.points.map((point) => [point.node.id, displayPosition(point)]));

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.fillStyle = '#0d1014';
    ctx.fillRect(0, 0, width, height);
    ctx.translate(width / 2 + offsetX, height / 2 + offsetY);
    ctx.scale(scale, scale);
    if (stats) stats.textContent = `显示 ${view.visible.size} / ${nodes.size}`;

    ctx.strokeStyle = 'rgba(150,164,180,.34)';
    ctx.lineWidth = 1.1 / scale;
    ctx.beginPath();
    for (const { a, b } of view.links) {
      const ap = display.get(a.node.id);
      const bp = display.get(b.node.id);
      const dx = bp.x - ap.x;
      const dy = bp.y - ap.y;
      const distance = Math.hypot(dx, dy);
      if (!distance) continue;
      const ux = dx / distance;
      const uy = dy / distance;
      const from = boundaryDistance(labelMetrics(a.node), ux, uy);
      const to = boundaryDistance(labelMetrics(b.node), ux, uy);
      if (distance <= from + to) continue;
      ctx.moveTo(ap.x + ux * from, ap.y + uy * from);
      ctx.lineTo(bp.x - ux * to, bp.y - uy * to);
    }
    ctx.stroke();

    for (const point of view.points) {
      const at = display.get(point.node.id);
      const metrics = labelMetrics(point.node);
      const widthWorld = metrics.widthScreen / scale;
      const heightWorld = metrics.heightScreen / scale;
      const selected = point.node.id === focusId;
      const color = COLORS[point.node.region] || COLORS.unknown;
      roundedRect(
        ctx,
        at.x - widthWorld / 2,
        at.y - heightWorld / 2,
        widthWorld,
        heightWorld,
        8 / scale
      );
      ctx.fillStyle = selected ? color : 'rgba(19,24,31,.94)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#f3efe4' : color;
      ctx.lineWidth = (selected ? 2.2 : 1.15) / scale;
      ctx.stroke();
      ctx.fillStyle = selected ? '#101419' : '#ece8df';
      ctx.font = `${selected ? 650 : 520} ${metrics.fontScreen / scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(point.node.name, at.x, at.y, widthWorld - 10 / scale);
    }
  }

  function requestDraw() {
    if (!drawFrame) drawFrame = requestAnimationFrame(draw);
  }

  function resize() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    draw();
  }

  function center(id) {
    const point = positions.get(id);
    if (!point) return;
    offsetX = -point.x * scale;
    offsetY = -point.y * scale;
    draw();
  }

  function screenPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function zoomAt(nextScale, screenX, screenY) {
    const worldX = (screenX - canvas.clientWidth / 2 - offsetX) / scale;
    const worldY = (screenY - canvas.clientHeight / 2 - offsetY) / scale;
    scale = clamp(nextScale, 0.14, 5);
    offsetX = screenX - canvas.clientWidth / 2 - worldX * scale;
    offsetY = screenY - canvas.clientHeight / 2 - worldY * scale;
  }

  function beginGpuGesture() {
    if (gestureBase || !canvas.width) return;
    gestureBase = { scale, offsetX, offsetY };
    canvas.style.transformOrigin = '0 0';
    canvas.style.willChange = 'transform';
  }

  function applyGpuTransform() {
    transformFrame = 0;
    if (!gestureBase) return;
    const ratio = scale / gestureBase.scale;
    const tx = canvas.clientWidth / 2 + offsetX -
      ratio * (canvas.clientWidth / 2 + gestureBase.offsetX);
    const ty = canvas.clientHeight / 2 + offsetY -
      ratio * (canvas.clientHeight / 2 + gestureBase.offsetY);
    canvas.style.transform = `matrix(${ratio},0,0,${ratio},${tx},${ty})`;
  }

  function requestGpuTransform() {
    if (!transformFrame) transformFrame = requestAnimationFrame(applyGpuTransform);
  }

  function finishGpuGesture({ redraw = true } = {}) {
    if (transformFrame) cancelAnimationFrame(transformFrame);
    transformFrame = 0;
    canvas.style.transform = 'none';
    canvas.style.willChange = '';
    gestureBase = null;
    if (redraw) draw();
  }

  function hit(screenX, screenY) {
    metricsCache = new Map();
    for (const point of [...viewData().points].reverse()) {
      const at = displayPosition(point);
      const metrics = labelMetrics(point.node);
      const x = canvas.clientWidth / 2 + offsetX + at.x * scale;
      const y = canvas.clientHeight / 2 + offsetY + at.y * scale;
      if (
        Math.abs(screenX - x) <= metrics.widthScreen / 2 + 4 &&
        Math.abs(screenY - y) <= metrics.heightScreen / 2 + 4
      ) return point.node;
    }
    return null;
  }

  function beginPointer(event) {
    followFocus = false;
    beginGpuGesture();
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
    followFocus = false;
    pointers.clear();
    const rect = canvas.getBoundingClientRect();
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
    if (graph) beginGpuGesture();
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
      requestGpuTransform();
      return;
    }
    if (drag) {
      offsetX += point.x - drag.x;
      offsetY += point.y - drag.y;
      drag.x = point.x;
      drag.y = point.y;
      drag.moved = true;
      requestGpuTransform();
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
      finishGpuGesture();
    }
    pinch = null;
    if (chosen) onChoose(chosen.id);
  }

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    beginPointer(event);
  });
  canvas.addEventListener('pointermove', movePointer);
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      followFocus = false;
      const point = screenPoint(event);
      zoomAt(scale * (event.deltaY > 0 ? 0.86 : 1.16), point.x, point.y);
      requestDraw();
    },
    { passive: false }
  );

  return {
    async open(id) {
      await load();
      focusId = id;
      measureHops(id);
      scale = 1;
      followFocus = true;
      resize();
      center(id);
      if (pointers.size) {
        followFocus = false;
        beginGpuGesture();
      }
    },
    resize,
    adoptPointers,
    moveAdoptedPointer: movePointer,
    endAdoptedPointer: endPointer,
    cancelPointers() {
      pointers.clear();
      drag = null;
      pinch = null;
      finishGpuGesture();
    },
  };
}
