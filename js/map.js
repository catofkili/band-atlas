const COLORS = {
  'east-asia': '#ef9f5a',
  western: '#79aefc',
  other: '#a891d7',
  unknown: '#737b87',
};
const STAGES = [
  { scale: 1, count: 9 },
  { scale: 0.68, count: 40 },
  { scale: 0.42, count: 160 },
  { scale: 0.21, count: Infinity },
];
const OVERSCAN = 2;
const MAX_SNAPSHOT_PIXELS = 4_000_000;

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

function makeBuffer(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const buffer = document.createElement('canvas');
  buffer.width = width;
  buffer.height = height;
  return buffer;
}

export function createNetworkMap({ canvas, onChoose }) {
  let graph;
  let nodes;
  let positions;
  let links;
  let adjacency;
  let rankedHops = [];
  let primaryIds = [];
  let localPositions = new Map();
  let stageViews = [];
  let snapshots = [];
  let activeStage = 0;
  let wantedStage = 0;
  let snapshotGeneration = 0;
  let snapshotRatio = 1;
  let viewportWidth = 1;
  let viewportHeight = 1;
  let canvasCssWidth = 1;
  let canvasCssHeight = 1;
  let canvasLeft = 0;
  let canvasTop = 0;
  let focusId;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let drag = null;
  let pinch = null;
  let transformFrame = 0;
  const pointers = new Map();
  const ctx = canvas.getContext('2d', { alpha: false });
  const surface = canvas.parentElement;
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

  function prepareFocus(id) {
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

    stageViews = STAGES.map((stage, index) => {
      const ids =
        index === 0
          ? [focusId, ...primaryIds.slice(0, 8)]
          : index === STAGES.length - 1
            ? [...nodes.keys()]
            : rankedHops.slice(0, stage.count).map(([nodeId]) => nodeId);
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

  function boundaryDistance(metrics, ux, uy, renderScale) {
    const halfWidth = metrics.widthScreen / renderScale / 2;
    const halfHeight = metrics.heightScreen / renderScale / 2;
    const tx = Math.abs(ux) < 0.0001 ? Infinity : halfWidth / Math.abs(ux);
    const ty = Math.abs(uy) < 0.0001 ? Infinity : halfHeight / Math.abs(uy);
    return Math.min(tx, ty);
  }

  function displayPosition(point, renderScale) {
    const local = localPositions.get(point.node.id);
    if (!local) return point;
    const focus = positions.get(focusId);
    const count = renderScale >= 0.82 ? Math.min(8, primaryIds.length) : primaryIds.length;
    const angle = renderScale >= 0.82
      ? local.compactAngle
      : -Math.PI / 2 + (local.index / Math.max(1, count)) * Math.PI * 2;
    const metrics = labelMetrics(point.node, renderScale);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let radiusScreen = local.radius * renderScale;
    if (Math.abs(cos) > 0.001) {
      radiusScreen = Math.min(
        radiusScreen,
        (viewportWidth / 2 - metrics.widthScreen / 2 - 14) / Math.abs(cos)
      );
    }
    if (Math.abs(sin) > 0.001) {
      radiusScreen = Math.min(
        radiusScreen,
        (viewportHeight / 2 - metrics.heightScreen / 2 - 68) / Math.abs(sin)
      );
    }
    const focusMetrics = labelMetrics(focus.node, renderScale);
    const minimumScreen = (
      boundaryDistance(focusMetrics, cos, sin, renderScale) +
      boundaryDistance(metrics, cos, sin, renderScale)
    ) * renderScale + 12;
    const radius = Math.max(minimumScreen, radiusScreen) / renderScale;
    return { x: focus.x + cos * radius, y: focus.y + sin * radius };
  }

  function renderSnapshot(buffer, stageIndex) {
    const stage = STAGES[stageIndex];
    const view = stageViews[stageIndex];
    const renderScale = stage.scale;
    const bufferCtx = buffer.getContext('2d', { alpha: false });
    const width = buffer.width / snapshotRatio;
    const height = buffer.height / snapshotRatio;
    const focus = positions.get(focusId);
    const baseOffsetX = -focus.x * renderScale;
    const baseOffsetY = -focus.y * renderScale;
    const display = new Map(
      view.points.map((point) => [point.node.id, displayPosition(point, renderScale)])
    );

    bufferCtx.setTransform(snapshotRatio, 0, 0, snapshotRatio, 0, 0);
    bufferCtx.fillStyle = '#0d1014';
    bufferCtx.fillRect(0, 0, width, height);
    bufferCtx.translate(width / 2 + baseOffsetX, height / 2 + baseOffsetY);
    bufferCtx.scale(renderScale, renderScale);
    bufferCtx.strokeStyle = 'rgba(150,164,180,.34)';
    bufferCtx.lineWidth = 1.1 / renderScale;
    bufferCtx.beginPath();
    for (const { a, b } of view.links) {
      const ap = display.get(a.node.id);
      const bp = display.get(b.node.id);
      const dx = bp.x - ap.x;
      const dy = bp.y - ap.y;
      const distance = Math.hypot(dx, dy);
      if (!distance) continue;
      const ux = dx / distance;
      const uy = dy / distance;
      const from = boundaryDistance(labelMetrics(a.node, renderScale), ux, uy, renderScale);
      const to = boundaryDistance(labelMetrics(b.node, renderScale), ux, uy, renderScale);
      if (distance <= from + to) continue;
      bufferCtx.moveTo(ap.x + ux * from, ap.y + uy * from);
      bufferCtx.lineTo(bp.x - ux * to, bp.y - uy * to);
    }
    bufferCtx.stroke();

    for (const point of view.points) {
      const at = display.get(point.node.id);
      const metrics = labelMetrics(point.node, renderScale);
      const widthWorld = metrics.widthScreen / renderScale;
      const heightWorld = metrics.heightScreen / renderScale;
      const selected = point.node.id === focusId;
      const color = COLORS[point.node.region] || COLORS.unknown;
      roundedRect(
        bufferCtx,
        at.x - widthWorld / 2,
        at.y - heightWorld / 2,
        widthWorld,
        heightWorld,
        8 / renderScale
      );
      bufferCtx.fillStyle = selected ? color : 'rgba(19,24,31,.94)';
      bufferCtx.fill();
      bufferCtx.strokeStyle = selected ? '#f3efe4' : color;
      bufferCtx.lineWidth = (selected ? 2.2 : 1.15) / renderScale;
      bufferCtx.stroke();
      bufferCtx.fillStyle = selected ? '#101419' : '#ece8df';
      bufferCtx.font =
        `${selected ? 650 : 520} ${metrics.fontScreen / renderScale}px system-ui, sans-serif`;
      bufferCtx.textAlign = 'center';
      bufferCtx.textBaseline = 'middle';
      bufferCtx.fillText(point.node.name, at.x, at.y, widthWorld - 10 / renderScale);
    }
  }

  function sizeCanvas() {
    viewportWidth = Math.max(1, canvas.parentElement.clientWidth);
    viewportHeight = Math.max(1, canvas.parentElement.clientHeight);
    canvasCssWidth = Math.ceil(viewportWidth * OVERSCAN);
    canvasCssHeight = Math.ceil(viewportHeight * OVERSCAN);
    canvasLeft = -(canvasCssWidth - viewportWidth) / 2;
    canvasTop = -(canvasCssHeight - viewportHeight) / 2;
    snapshotRatio = Math.min(
      window.devicePixelRatio || 1,
      1.25,
      Math.sqrt(MAX_SNAPSHOT_PIXELS / (canvasCssWidth * canvasCssHeight))
    );
    canvas.style.width = `${canvasCssWidth}px`;
    canvas.style.height = `${canvasCssHeight}px`;
    canvas.style.left = `${canvasLeft}px`;
    canvas.style.top = `${canvasTop}px`;
    canvas.style.position = 'absolute';
    canvas.style.transformOrigin = '0 0';
    canvas.width = Math.round(canvasCssWidth * snapshotRatio);
    canvas.height = Math.round(canvasCssHeight * snapshotRatio);
  }

  function copySnapshot(stageIndex) {
    const snapshot = snapshots[stageIndex];
    if (!snapshot) return false;
    activeStage = stageIndex;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(snapshot, 0, 0);
    if (stats) {
      const shown = stageViews[stageIndex].visible.size;
      stats.textContent = `阶段 ${stageIndex + 1}/4 · 显示 ${shown} / ${nodes.size}`;
    }
    applyTransform();
    return true;
  }

  function applyTransform() {
    transformFrame = 0;
    if (!snapshots[activeStage]) return;
    const stageScale = STAGES[activeStage].scale;
    const focus = positions.get(focusId);
    const baseOffsetX = -focus.x * stageScale;
    const baseOffsetY = -focus.y * stageScale;
    const ratio = scale / stageScale;
    const tx = viewportWidth / 2 + offsetX - canvasLeft -
      ratio * (canvasCssWidth / 2 + baseOffsetX);
    const ty = viewportHeight / 2 + offsetY - canvasTop -
      ratio * (canvasCssHeight / 2 + baseOffsetY);
    canvas.style.transform = `matrix(${ratio},0,0,${ratio},${tx},${ty})`;
  }

  function requestTransform() {
    if (!transformFrame) transformFrame = requestAnimationFrame(applyTransform);
  }

  function chooseStage() {
    wantedStage = stageForScale(scale);
    if (wantedStage !== activeStage && snapshots[wantedStage]) copySnapshot(wantedStage);
    else requestTransform();
  }

  async function preloadStages() {
    const generation = ++snapshotGeneration;
    for (const snapshot of snapshots) snapshot?.close?.();
    snapshots = new Array(STAGES.length);
    sizeCanvas();
    for (let index = 0; index < STAGES.length; index += 1) {
      if (generation !== snapshotGeneration) return;
      const buffer = makeBuffer(canvas.width, canvas.height);
      renderSnapshot(buffer, index);
      snapshots[index] =
        typeof buffer.transferToImageBitmap === 'function'
          ? buffer.transferToImageBitmap()
          : buffer;
      if (index === 0 || index === wantedStage) copySnapshot(index);
      if (stats && index < STAGES.length - 1) {
        stats.textContent = `预载地图 ${index + 1}/4`;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (generation !== snapshotGeneration) return;
    copySnapshot(stageForScale(scale));
  }

  function screenPoint(event) {
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function zoomAt(nextScale, screenX, screenY) {
    const worldX = (screenX - viewportWidth / 2 - offsetX) / scale;
    const worldY = (screenY - viewportHeight / 2 - offsetY) / scale;
    scale = clamp(nextScale, 0.14, 5);
    offsetX = screenX - viewportWidth / 2 - worldX * scale;
    offsetY = screenY - viewportHeight / 2 - worldY * scale;
  }

  function hit(screenX, screenY) {
    const stageScale = STAGES[activeStage].scale;
    for (const point of [...stageViews[activeStage].points].reverse()) {
      const at = displayPosition(point, stageScale);
      const metrics = labelMetrics(point.node, stageScale);
      const x = viewportWidth / 2 + offsetX + at.x * scale;
      const y = viewportHeight / 2 + offsetY + at.y * scale;
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
      chooseStage();
      return;
    }
    if (drag) {
      offsetX += point.x - drag.x;
      offsetY += point.y - drag.y;
      drag.x = point.x;
      drag.y = point.y;
      drag.moved = true;
      requestTransform();
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
      chooseStage();
    },
    { passive: false }
  );

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
