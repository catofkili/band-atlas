const COLORS = { 'east-asia': '#ef9f5a', western: '#79aefc', other: '#a891d7', unknown: '#737b87' };
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// 这不是把节点随便撒在画布上：每条真实关系都会把两端拉近，
// 同时只和附近的节点轻微相斥。因此同一音乐圈会自然聚成团，
// 又不会为了算布局而把手机主线程卡住。
export function createNetworkMap({ canvas, onChoose }) {
  let graph, nodes, pos, links, scale = 1, ox = 0, oy = 0, drag, focusId;
  let pointers = new Map(), pinchDistance = 0, layoutStarted = false;
  const ctx = canvas.getContext('2d');

  async function load() {
    if (graph) return;
    graph = await fetch('data/graph.json').then((r) => r.json());
    nodes = new Map(graph.nodes.map((n, i) => [n.id, { ...n, i }]));
    pos = new Map();
    for (const n of graph.nodes) {
      const h = hash(n.id), angle = (h % 6283) / 1000;
      const radius = 280 + Math.sqrt(h % 850000) * 2.35;
      pos.set(n.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 });
    }
    links = graph.edges.map((edge) => [pos.get(edge.from), pos.get(edge.to)]).filter(([a, b]) => a && b);
  }

  async function settleLayout() {
    if (layoutStarted) return;
    layoutStarted = true;
    const points = [...pos.values()], cellSize = 145;
    for (let step = 0; step < 150; step += 1) {
      const grid = new Map();
      for (const p of points) {
        const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
        const bucket = grid.get(key) || []; bucket.push(p); grid.set(key, bucket);
      }
      for (const p of points) {
        let fx = -p.x * 0.0007, fy = -p.y * 0.0007;
        const gx = Math.floor(p.x / cellSize), gy = Math.floor(p.y / cellSize);
        for (let x = gx - 1; x <= gx + 1; x += 1) for (let y = gy - 1; y <= gy + 1; y += 1) {
          for (const q of grid.get(`${x},${y}`) || []) {
            if (p === q) continue;
            const dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy + 1;
            if (d2 < cellSize * cellSize) { const k = 3100 / d2; fx += dx * k; fy += dy * k; }
          }
        }
        p.vx = (p.vx + fx) * 0.76; p.vy = (p.vy + fy) * 0.76;
      }
      for (const [a, b] of links) {
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const pull = (d - 92) * 0.0105, fx = dx / d * pull, fy = dy / d * pull;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const p of points) { p.x += p.vx; p.y += p.vy; }
      if (step % 6 === 0) { draw(); await nextFrame(); }
    }
    draw();
  }

  function resize() {
    canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.max(1, canvas.clientHeight * devicePixelRatio);
    draw();
  }

  function draw() {
    if (!graph || !canvas.width) return;
    const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2 + ox, h / 2 + oy); ctx.scale(scale, scale);
    ctx.strokeStyle = 'rgba(125,140,160,.18)'; ctx.lineWidth = 1 / scale; ctx.beginPath();
    for (const [a, b] of links) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
    for (const n of nodes.values()) {
      const p = pos.get(n.id), r = Math.max(2.3, Math.min(7, 2.4 + Math.log2(n.degree + 1)));
      ctx.fillStyle = COLORS[n.region] || COLORS.unknown;
      if (n.id === focusId) { ctx.strokeStyle = '#f3efe4'; ctx.lineWidth = 2.5 / scale; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4 / scale, 0, Math.PI * 2); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(p.x, p.y, r / scale, 0, Math.PI * 2); ctx.fill();
      if (n.id === focusId || (scale > 1.6 && n.degree >= 14)) {
        ctx.fillStyle = '#e7e4dc'; ctx.font = `${11 / scale}px system-ui`; ctx.fillText(n.name, p.x + 8 / scale, p.y - 6 / scale);
      }
    }
  }

  function center(id) { const p = pos.get(id); if (p) { ox = -p.x * scale; oy = -p.y * scale; draw(); } }
  function hit(x, y) {
    const w = canvas.clientWidth, h = canvas.clientHeight; let best, bestDistance = 18;
    for (const n of nodes.values()) { const p = pos.get(n.id), distance = Math.hypot(w / 2 + ox + p.x * scale - x, h / 2 + oy + p.y * scale - y); if (distance < bestDistance) { best = n; bestDistance = distance; } }
    return best;
  }
  function pointerDistance() { const pair = [...pointers.values()]; return pair.length === 2 ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0; }

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinchDistance = pointerDistance(); drag = { x: event.clientX, y: event.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const distance = pointerDistance();
      if (pinchDistance) scale = Math.max(.12, Math.min(5, scale * distance / pinchDistance));
      pinchDistance = distance; if (drag) drag.moved = true; draw(); return;
    }
    if (drag) { ox += event.clientX - drag.x; oy += event.clientY - drag.y; drag.x = event.clientX; drag.y = event.clientY; drag.moved = true; draw(); }
  });
  function endPointer(event) {
    pointers.delete(event.pointerId); pinchDistance = pointerDistance();
    if (!pointers.size && drag && !drag.moved) { const node = hit(event.clientX, event.clientY); if (node) onChoose(node.id); }
    drag = pointers.size ? { ...[...pointers.values()][0], moved: true } : null;
  }
  canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (event) => { event.preventDefault(); scale = Math.max(.12, Math.min(5, scale * (event.deltaY > 0 ? .86 : 1.16))); draw(); }, { passive: false });

  return { async open(id) { await load(); focusId = id; resize(); center(id); settleLayout(); }, resize };
}
