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
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function textUnits(text) {
  return [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 1 : 0.62), 0);
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, r);
}

export function createNetworkMap({ canvas, onChoose }) {
  let graph;
  let nodes;
  let positions;
  let links;
  let adjacency;
  let hops;
  let primaryIds = [];
  let localPositions = new Map();
  let focusId;
  let followFocus = true;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let layoutStarted = false;
  let drag = null;
  let pinch = null;
  const pointers = new Map();
  const ctx = canvas.getContext('2d');
  const stats = document.getElementById('map-stats');

  async function load() {
    if (graph) return;
    graph = await fetch('data/graph.json').then((response) => response.json());
    nodes = new Map(
      graph.nodes.map((node) => [
        node.id,
        {
          ...node,
          labelWidth: clamp(textUnits(node.name) * 11 + 18, 42, 188),
        },
      ])
    );
    positions = new Map();

    const ordered = [...nodes.values()].sort((a, b) => hash(a.id) - hash(b.id));
    ordered.forEach((node, index) => {
      const angle = index * 2.399963229728653;
      const radius = 18 * Math.sqrt(index);
      positions.set(node.id, {
        node,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      });
    });

    links = graph.edges
      .map((edge) => ({
        edge,
        a: positions.get(edge.from),
        b: positions.get(edge.to),
      }))
      .filter(({ a, b }) => a && b);
    adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const { a, b } of links) {
      adjacency.get(a.node.id).push(b.node.id);
      adjacency.get(b.node.id).push(a.node.id);
    }
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

    const focus = positions.get(id);
    primaryIds = [...(adjacency.get(id) || [])].sort((a, b) => {
      const degreeDifference = (nodes.get(b)?.degree || 0) - (nodes.get(a)?.degree || 0);
      return degreeDifference || hash(a) - hash(b);
    });
    localPositions = new Map();
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
    const compactOrder = [...primaryIds.slice(0, 8)].sort(
      (a, b) => nodes.get(b).labelWidth - nodes.get(a).labelWidth
    );
    const compactAngle = new Map(compactOrder.map((neighborId, index) => [neighborId, compactAngles[index]]));
    primaryIds.forEach((neighborId, index) => {
      const neighbor = positions.get(neighborId);
      const base = desiredLinkLength(focus, neighbor);
      const radius = base * (index % 2 ? 1.24 : 1);
      localPositions.set(neighborId, {
        index,
        radius,
        compactAngle: compactAngle.get(neighborId),
      });
    });
  }

  function visibleIds() {
    // 和地图一样：近看是当前街区，缩远才逐层看到更大的区域。
    if (scale >= 0.82) return new Set([focusId, ...primaryIds.slice(0, 8)]);
    const depth = scale >= 0.48 ? 2 : scale >= 0.27 ? 3 : Infinity;
    const budget = scale >= 0.48
      ? Math.round(20 + (0.82 - scale) * 100)
      : scale >= 0.27
        ? Math.round(55 + (0.48 - scale) * 350)
        : Math.round(130 + (0.27 - scale) * 7000);
    const candidates = [...hops]
      .filter(([, hop]) => hop <= depth)
      .sort(([a, hopA], [b, hopB]) => {
        if (hopA !== hopB) return hopA - hopB;
        return (nodes.get(b)?.degree || 0) - (nodes.get(a)?.degree || 0) || hash(a) - hash(b);
      });
    return new Set(candidates.slice(0, budget).map(([id]) => id));
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
    return {
      x: focus.x + cos * radius,
      y: focus.y + sin * radius,
    };
  }

  function desiredLinkLength(a, b) {
    const bubbleHalves = (a.node.labelWidth + b.node.labelWidth) / 2;
    const visibleLine = Math.min(46, Math.max(a.node.labelWidth, b.node.labelWidth) * 0.48);
    return bubbleHalves + visibleLine;
  }

  async function settleLayout() {
    if (layoutStarted) return;
    layoutStarted = true;
    const points = [...positions.values()];
    const cellSize = 210;

    for (let step = 0; step < 420; step += 1) {
      const grid = new Map();
      for (const point of points) {
        const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
        const bucket = grid.get(key) || [];
        bucket.push(point);
        grid.set(key, bucket);
      }

      for (const point of points) {
        point.vx += -point.x * 0.00075;
        point.vy += -point.y * 0.00075;
        const gx = Math.floor(point.x / cellSize);
        const gy = Math.floor(point.y / cellSize);

        for (let x = gx - 1; x <= gx + 1; x += 1) {
          for (let y = gy - 1; y <= gy + 1; y += 1) {
            for (const other of grid.get(`${x},${y}`) || []) {
              if (point === other || point.node.id > other.node.id) continue;
              let dx = other.x - point.x;
              let dy = other.y - point.y;
              if (dx === 0 && dy === 0) dx = 0.01;
              const minX = (point.node.labelWidth + other.node.labelWidth) / 2 + 10;
              const minY = 34;
              const overlapX = minX - Math.abs(dx);
              const overlapY = minY - Math.abs(dy);
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
      }

      for (const { a, b } of links) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const force = (distance - desiredLinkLength(a, b)) * 0.042;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const point of points) {
        point.vx *= 0.58;
        point.vy *= 0.58;
        point.x += point.vx;
        point.y += point.vy;
      }

      if (step % 8 === 0) {
        draw();
        await nextFrame();
      }
    }
    draw();
  }

  function labelMetrics(node) {
    // 名字永远存在。缩远时字体会变小，但不会退化成没有含义的圆点。
    const fontScreen = clamp(11 * Math.sqrt(scale), 7.2, 12);
    const ratio = fontScreen / 11;
    return {
      fontScreen,
      widthScreen: node.labelWidth * ratio,
      heightScreen: clamp(22 * Math.sqrt(scale), 14, 25),
    };
  }

  function boundaryDistance(metrics, ux, uy) {
    const halfWidth = metrics.widthScreen / scale / 2;
    const halfHeight = metrics.heightScreen / scale / 2;
    const tx = Math.abs(ux) < 0.0001 ? Infinity : halfWidth / Math.abs(ux);
    const ty = Math.abs(uy) < 0.0001 ? Infinity : halfHeight / Math.abs(uy);
    return Math.min(tx, ty);
  }

  function draw() {
    if (!graph || !canvas.width) return;
    const width = canvas.width / devicePixelRatio;
    const height = canvas.height / devicePixelRatio;
    if (followFocus) {
      const focus = positions.get(focusId);
      if (focus) {
        offsetX = -focus.x * scale;
        offsetY = -focus.y * scale;
      }
    }
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2 + offsetX, height / 2 + offsetY);
    ctx.scale(scale, scale);
    const visible = visibleIds();
    if (stats) stats.textContent = `显示 ${visible.size} / ${nodes.size}`;

    ctx.strokeStyle = 'rgba(150,164,180,.34)';
    ctx.lineWidth = 1.1 / scale;
    ctx.beginPath();
    for (const { a, b } of links) {
      if (!visible.has(a.node.id) || !visible.has(b.node.id)) continue;
      const ap = displayPosition(a);
      const bp = displayPosition(b);
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

    const visiblePoints = [...positions.values()].filter((point) => visible.has(point.node.id));
    visiblePoints.sort((a, b) => (a.node.id === focusId ? 1 : 0) - (b.node.id === focusId ? 1 : 0));
    for (const point of visiblePoints) {
      const display = displayPosition(point);
      const metrics = labelMetrics(point.node);
      const widthWorld = metrics.widthScreen / scale;
      const heightWorld = metrics.heightScreen / scale;
      const x = display.x - widthWorld / 2;
      const y = display.y - heightWorld / 2;
      const color = COLORS[point.node.region] || COLORS.unknown;
      const selected = point.node.id === focusId;

      roundedRect(ctx, x, y, widthWorld, heightWorld, 8 / scale);
      ctx.fillStyle = selected ? color : 'rgba(19,24,31,.94)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#f3efe4' : color;
      ctx.lineWidth = (selected ? 2.2 : 1.15) / scale;
      ctx.stroke();

      ctx.fillStyle = selected ? '#101419' : '#ece8df';
      ctx.font = `${selected ? 650 : 520} ${metrics.fontScreen / scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(point.node.name, display.x, display.y, widthWorld - 10 / scale);
    }
  }

  function resize() {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
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
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const worldX = (screenX - width / 2 - offsetX) / scale;
    const worldY = (screenY - height / 2 - offsetY) / scale;
    scale = clamp(nextScale, 0.14, 5);
    offsetX = screenX - width / 2 - worldX * scale;
    offsetY = screenY - height / 2 - worldY * scale;
  }

  function hit(screenX, screenY) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const visible = visibleIds();
    for (const point of [...positions.values()].reverse()) {
      if (!visible.has(point.node.id)) continue;
      const display = displayPosition(point);
      const metrics = labelMetrics(point.node);
      const x = width / 2 + offsetX + display.x * scale;
      const y = height / 2 + offsetY + display.y * scale;
      if (
        Math.abs(screenX - x) <= metrics.widthScreen / 2 + 4 &&
        Math.abs(screenY - y) <= metrics.heightScreen / 2 + 4
      ) return point.node;
    }
    return null;
  }

  function beginPointer(event) {
    followFocus = false;
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
      pointers.set(entry.id, {
        x: entry.clientX - rect.left,
        y: entry.clientY - rect.top,
      });
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
      draw();
      return;
    }

    if (drag) {
      offsetX += point.x - drag.x;
      offsetY += point.y - drag.y;
      drag.x = point.x;
      drag.y = point.y;
      drag.moved = true;
      draw();
    }
  }

  function endPointer(event) {
    const point = screenPoint(event);
    pointers.delete(event.pointerId);
    if (!pointers.size && drag && !drag.moved) {
      const node = hit(point.x, point.y);
      if (node) onChoose(node.id);
    }
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      drag = { ...remaining, moved: true };
    } else if (!pointers.size) {
      drag = null;
    }
    pinch = null;
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
      draw();
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
      settleLayout();
    },
    resize,
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
