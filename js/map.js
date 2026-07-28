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
// 阶段分界带滞回：已经退到粗阶段时要多放大一点才回到细阶段，
// 否则在阈值上抖一下，整批节点就闪进闪出。
const STAGE_THRESHOLDS = [0.82, 0.55, 0.38];
const STAGE_HYSTERESIS = 0.08;
const STAGE_FADE_MS = 220;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_PIXEL_RATIO = 2;
const MAP_POPULAR_LISTEN_FLOOR = 1000;
// 每级实际画多少个点，按视口面积算。原来是固定 9 / 40 / 160，
// 在桌面尺寸上近景永远只有焦点那一小撮，四周全黑——「地图很空」就是这么来的。
const FILL_PER_MEGAPIXEL = [46, 120, 300];
const LABEL_LIMITS_PER_MEGAPIXEL = [Infinity, 100, 92, 42];
const LABEL_LIMIT_FLOORS = [9, 22, 26, 13];
const LABEL_GAPS = [4, 5, 6, 7];
// CJK 要显式点名字体，光靠 system-ui 在部分机器上会落到宽度完全不同的后备字体，
// 于是测出来的宽度和画出来的字对不上。
const LABEL_FONT = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", sans-serif';
const LABEL_MAX_TEXT = 168;
const LABEL_MIN_WIDTH = 42;
const LABEL_MAX_WIDTH = 188;
const LABEL_PAD = 20;
// 上一帧已经显示的标签带一点优先级加成，新标签要明显更重要才顶得掉它。
// 没有这个迟滞，轻轻一拖两个互相冲突的标签就会来回换人闪烁。
const LABEL_KEEP_BONUS = 1.3;
// 缩小的下限不是固定值，而是「整张图刚好铺满屏幕」再留一点余量。
// 原来固定 0.14，在桌面尺寸上等于允许一直缩到全图只剩屏幕中央一小团。
const MIN_SCALE_SLACK = 0.94;
const MAX_SCALE = 4;
const CAMERA_MS = 130;
const HIT_PAD_MOUSE = 14;
const HIT_PAD_TOUCH = 22;
// 拖出世界边界后的阻尼与最大越界距离，松手回弹。
const RUBBER_DAMP = 0.35;
const RUBBER_MAX = 150;
const FIT_PADDING = 120;
const GRAPH_VERSION = '361f7b767d';

const hash = (text) => {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
}

export function createNetworkMap({
  canvas,
  onChoose,
  onGestureChoose,
  popularOnly: initialPopularOnly = true,
  onPopularChange,
  describe,
}) {
  let graph;
  let nodes;
  let positions;
  let links;
  let adjacency;
  let worldBounds = null;
  let rankedHops = [];
  let primaryIds = [];
  let allowedIds = [];
  let stageViews = [];
  let stageAnchor = null;
  let activeStage = 0;
  let wantedStage = 0;
  let pixelRatio = 1;
  let viewportWidth = 1;
  let viewportHeight = 1;
  let cardId; // 卡片视图当前打开的乐队，返回时的形变起点
  let focusId; // 地图里当前被当作中心的乐队，可以在地图内改
  let hoverId = null;
  let previewId = null;

  // 相机分「当前」与「目标」两套：手指拖动直接写当前值（必须跟手），
  // 缩放、回到焦点、回弹都只写目标值，由 rAF 补间追上去。
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let targetScale = 1;
  let targetOffsetX = 0;
  let targetOffsetY = 0;
  let zoomAnchor = null;
  let lastFrameTime = 0;

  // 地图的视图记忆：关掉再开回到原处，否则每次进出都被打回初始 9 个节点，
  // 地图就只能用来跳一步，没法真的逛。
  let savedView = null;

  let drag = null;
  let pinch = null;
  let popularOnly = initialPopularOnly;
  let renderFrame = 0;
  let renderedLabels = new Set();
  let renderedMetrics = new Map();
  let fadeInIds = new Set();
  let fadeOutPoints = [];
  let fadeStart = 0;
  let pickerBuilt = false;
  let pendingFit = null;
  const measureCache = new Map();
  const labelCache = new Map();
  const pointers = new Map();
  const ctx = canvas.getContext('2d', { alpha: false });
  const surface = canvas.parentElement;
  const stats = document.getElementById('map-stats');
  const picker = document.getElementById('map-band-select');
  const popularToggle = document.getElementById('map-popular-toggle');
  const homeButton = document.getElementById('map-home');
  const zoomInButton = document.getElementById('map-zoom-in');
  const zoomOutButton = document.getElementById('map-zoom-out');
  const legendBox = document.getElementById('map-legend-box');
  const preview = document.getElementById('map-preview');
  const previewName = document.getElementById('map-preview-name');
  const previewMeta = document.getElementById('map-preview-meta');
  const previewCounts = document.getElementById('map-preview-counts');
  const previewEnter = document.getElementById('map-preview-enter');
  const previewCenter = document.getElementById('map-preview-center');
  const previewClose = document.getElementById('map-preview-close');
  const debug = new URLSearchParams(location.search).has('mapdebug');

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
    nodes = new Map(graph.nodes.map((node) => [node.id, { ...node }]));
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
    const xs = [...positions.values()].map((point) => point.x);
    const ys = [...positions.values()].map((point) => point.y);
    worldBounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }

  /* ---------------------------------------------------------------- 文本 */

  // 标签宽度必须用 measureText 实测。原来按字符数估算，估窄了就会触发
  // fillText 的 maxWidth，而 canvas 的 maxWidth 是把字**横向压扁**而不是截断，
  // 长名字于是全糊成一团——这是「显示不对劲」最主要的一处。
  function measure(text) {
    let width = measureCache.get(text);
    if (width == null) {
      ctx.font = `520 11px ${LABEL_FONT}`;
      width = ctx.measureText(text).width;
      measureCache.set(text, width);
    }
    return width;
  }

  function labelOf(node) {
    let cached = labelCache.get(node.id);
    if (cached) return cached;
    let text = node.name;
    if (measure(text) > LABEL_MAX_TEXT) {
      // 宁可截短加省略号，也不要把字压扁。
      const chars = [...text];
      let low = 1;
      let high = chars.length;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (measure(`${chars.slice(0, mid).join('')}…`) <= LABEL_MAX_TEXT) low = mid;
        else high = mid - 1;
      }
      text = `${chars.slice(0, low).join('')}…`;
    }
    cached = {
      text,
      width: clamp(measure(text) + LABEL_PAD, LABEL_MIN_WIDTH, LABEL_MAX_WIDTH),
    };
    labelCache.set(node.id, cached);
    return cached;
  }

  /* ---------------------------------------------------------------- 视图集合 */

  function buildPicker() {
    if (!picker || pickerBuilt) return;
    const fragment = document.createDocumentFragment();
    for (const node of [...nodes.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-CN')
    )) {
      const option = document.createElement('option');
      option.value = node.id;
      option.textContent = `${node.name}${node.region === 'east-asia' ? ' · 东亚' : ''}`;
      fragment.append(option);
    }
    picker.replaceChildren(fragment);
    pickerBuilt = true;
  }

  function prepareFocus(id) {
    buildPicker();
    const allowed = (nodeId) =>
      !popularOnly ||
      nodeId === id ||
      nodes.get(nodeId)?.regionalFeatured ||
      (nodes.get(nodeId)?.listens ?? 0) >= MAP_POPULAR_LISTEN_FLOOR;

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

    primaryIds = [...(adjacency.get(id) || [])].sort((a, b) => {
      const degreeDifference = (nodes.get(b)?.degree || 0) - (nodes.get(a)?.degree || 0);
      return degreeDifference || hash(a) - hash(b);
    });
    allowedIds = [...nodes.keys()].filter(allowed);
    prepareViewportStages();
  }

  /**
   * 按「当前视口中心附近」重建四级视图。
   *
   * 原来只在缩小时重建，于是在近景平移出去就是一片纯黑——那一级里压根只存在
   * 焦点和它的 8 个邻居。现在只要视口中心挪得够远就重建，并且始终把焦点与它的
   * 一跳邻居并进去，保证关系上下文不会因为镜头挪开就消失。
   */
  function prepareViewportStages(screenX = viewportWidth / 2, screenY = viewportHeight / 2) {
    const centerX = (screenX - viewportWidth / 2 - offsetX) / scale;
    const centerY = (screenY - viewportHeight / 2 - offsetY) / scale;
    stageAnchor = { x: centerX, y: centerY };
    const nearestIds = [...nodes.keys()]
      .map((id) => {
        const point = positions.get(id);
        const dx = point.x - centerX;
        const dy = point.y - centerY;
        return { id, distance: dx * dx + dy * dy };
      })
      .sort((a, b) => a.distance - b.distance || hash(a.id) - hash(b.id))
      .map(({ id }) => id);

    const megapixels = (viewportWidth * viewportHeight) / 1_000_000;
    stageViews = STAGES.map((stage, index) => {
      let ids;
      if (index === STAGES.length - 1) {
        ids = allowedIds;
      } else {
        const anchors = index === 0
          ? [focusId, ...primaryIds.slice(0, 8)]
          : [focusId, ...primaryIds];
        const fill = Math.max(
          stage.count,
          Math.round(FILL_PER_MEGAPIXEL[index] * megapixels)
        );
        ids = [...new Set([...anchors, ...nearestIds.slice(0, fill)])];
      }
      const visible = new Set(ids.filter((id) => positions.has(id)));
      return {
        visible,
        points: [...positions.values()]
          .filter((point) => visible.has(point.node.id))
          .sort((a, b) => (a.node.id === focusId ? 1 : 0) - (b.node.id === focusId ? 1 : 0)),
        links: links.filter(({ a, b }) => visible.has(a.node.id) && visible.has(b.node.id)),
      };
    });
  }

  function maybeRebuildStages(force = false) {
    if (!stageViews.length) return;
    const centerX = -offsetX / scale;
    const centerY = -offsetY / scale;
    const threshold = (Math.min(viewportWidth, viewportHeight) * 0.3) / scale;
    if (
      !force &&
      stageAnchor &&
      Math.hypot(centerX - stageAnchor.x, centerY - stageAnchor.y) < threshold
    ) return;
    prepareViewportStages();
  }

  function stageForScale(value, current = activeStage) {
    for (let index = 0; index < STAGE_THRESHOLDS.length; index += 1) {
      const bias = current > index ? 1 + STAGE_HYSTERESIS : 1 - STAGE_HYSTERESIS;
      if (value >= STAGE_THRESHOLDS[index] * bias) return index;
    }
    return STAGES.length - 1;
  }

  function setStage(next) {
    if (next === activeStage) return;
    const previous = stageViews[activeStage];
    const upcoming = stageViews[next];
    if (previous && upcoming) {
      // 阶段切换时让离场的点淡出、入场的点淡入，而不是整批硬切。
      fadeOutPoints = previous.points.filter((point) => !upcoming.visible.has(point.node.id));
      fadeInIds = new Set(
        [...upcoming.visible].filter((id) => !previous.visible.has(id))
      );
      fadeStart = performance.now();
    }
    activeStage = next;
  }

  /* ---------------------------------------------------------------- 相机 */

  function minScale() {
    if (!worldBounds) return 0.14;
    const spanX = Math.max(1, worldBounds.maxX - worldBounds.minX);
    const spanY = Math.max(1, worldBounds.maxY - worldBounds.minY);
    return Math.min(viewportWidth / spanX, viewportHeight / spanY) * MIN_SCALE_SLACK;
  }

  /**
   * 平移边界：图比屏幕大时不许把图拖出屏幕外（屏幕永远被图盖满），
   * 图比屏幕小时整张图必须留在屏幕里。两种情况都保证屏幕上不会只剩黑。
   */
  function offsetRange(min, max, viewport, atScale) {
    const spanScreen = (max - min) * atScale;
    if (spanScreen <= viewport) {
      return {
        lower: -viewport / 2 - min * atScale,
        upper: viewport / 2 - max * atScale,
      };
    }
    return {
      lower: viewport / 2 - max * atScale,
      upper: -viewport / 2 - min * atScale,
    };
  }

  function clampOffsetX(value, atScale = scale) {
    if (!worldBounds) return value;
    const { lower, upper } = offsetRange(
      worldBounds.minX, worldBounds.maxX, viewportWidth, atScale
    );
    return clamp(value, lower, upper);
  }

  function clampOffsetY(value, atScale = scale) {
    if (!worldBounds) return value;
    const { lower, upper } = offsetRange(
      worldBounds.minY, worldBounds.maxY, viewportHeight, atScale
    );
    return clamp(value, lower, upper);
  }

  // 拖过界不是硬停，而是带阻尼地跟一点点，松手回弹——这样才知道「到头了」。
  function rubber(value, clamped) {
    if (value === clamped) return value;
    const overshoot = value - clamped;
    const damped = Math.sign(overshoot) *
      Math.min(RUBBER_MAX, Math.abs(overshoot) * RUBBER_DAMP);
    return clamped + damped;
  }

  function settleCamera() {
    // 视口变了下限也会变，先把缩放收回合法区间，再回弹越界的平移。
    targetScale = clamp(targetScale, minScale(), MAX_SCALE);
    targetOffsetX = clampOffsetX(targetOffsetX, targetScale);
    targetOffsetY = clampOffsetY(targetOffsetY, targetScale);
    requestRender();
  }

  function advanceCamera(now) {
    const delta = Math.min(64, now - (lastFrameTime || now));
    lastFrameTime = now;
    const k = 1 - Math.pow(0.001, delta / CAMERA_MS);
    let moving = false;
    if (Math.abs(Math.log(targetScale / scale)) > 0.0004) {
      scale = Math.exp(Math.log(scale) + (Math.log(targetScale) - Math.log(scale)) * k);
      moving = true;
    } else {
      scale = targetScale;
    }
    if (zoomAnchor) {
      // 缩放过程中把锚点世界坐标钉死在光标下，画面才不会从手底下滑走。
      offsetX = clampOffsetX(
        zoomAnchor.screenX - viewportWidth / 2 - zoomAnchor.worldX * scale
      );
      offsetY = clampOffsetY(
        zoomAnchor.screenY - viewportHeight / 2 - zoomAnchor.worldY * scale
      );
      targetOffsetX = offsetX;
      targetOffsetY = offsetY;
      if (!moving) zoomAnchor = null;
    } else if (
      Math.abs(targetOffsetX - offsetX) > 0.25 ||
      Math.abs(targetOffsetY - offsetY) > 0.25
    ) {
      offsetX += (targetOffsetX - offsetX) * k;
      offsetY += (targetOffsetY - offsetY) * k;
      moving = true;
    } else {
      offsetX = targetOffsetX;
      offsetY = targetOffsetY;
    }
    return moving;
  }

  function zoomAt(nextScale, screenX, screenY) {
    const worldX = (screenX - viewportWidth / 2 - targetOffsetX) / targetScale;
    const worldY = (screenY - viewportHeight / 2 - targetOffsetY) / targetScale;
    targetScale = clamp(nextScale, minScale(), MAX_SCALE);
    zoomAnchor = { worldX, worldY, screenX, screenY };
    targetOffsetX = clampOffsetX(
      screenX - viewportWidth / 2 - worldX * targetScale, targetScale
    );
    targetOffsetY = clampOffsetY(
      screenY - viewportHeight / 2 - worldY * targetScale, targetScale
    );
    chooseStage(screenX, screenY);
  }

  function panBy(dx, dy) {
    zoomAnchor = null;
    targetOffsetX = clampOffsetX(targetOffsetX + dx, targetScale);
    targetOffsetY = clampOffsetY(targetOffsetY + dy, targetScale);
    requestRender();
  }

  function flyTo(worldX, worldY, nextScale = targetScale, { instant = false } = {}) {
    zoomAnchor = null;
    targetScale = clamp(nextScale, minScale(), MAX_SCALE);
    targetOffsetX = clampOffsetX(-worldX * targetScale, targetScale);
    targetOffsetY = clampOffsetY(-worldY * targetScale, targetScale);
    if (instant) {
      scale = targetScale;
      offsetX = targetOffsetX;
      offsetY = targetOffsetY;
    }
    wantedStage = stageForScale(targetScale);
    setStage(wantedStage);
    requestRender();
  }

  function fitBounds(bounds, { instant = false, maxScale = 1.6, floor = 0 } = {}) {
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const fitted = Math.min(
      (viewportWidth - FIT_PADDING) / width,
      (viewportHeight - FIT_PADDING) / height
    );
    flyTo(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      clamp(Math.max(fitted, floor), minScale(), maxScale),
      { instant }
    );
  }

  /**
   * 进站时按「焦点 + 一跳邻居」撑满屏幕。原来固定 scale=1，9 个点缩在正中
   * 一小块，四周全是黑的。
   *
   * 包围盒要掐掉最远的四分之一邻居：影响关系常常连到布局上极远的乐队，
   * 一个离群点就能把镜头拉成全网远景，反倒看不清眼前这一圈。
   */
  function fitNeighborhood(id, { instant = false } = {}) {
    const focus = positions.get(id);
    const neighbors = (adjacency.get(id) || [])
      .map((nodeId) => positions.get(nodeId))
      .filter(Boolean)
      .sort(
        (a, b) =>
          Math.hypot(a.x - focus.x, a.y - focus.y) - Math.hypot(b.x - focus.x, b.y - focus.y)
      );
    if (!neighbors.length) {
      flyTo(focus.x, focus.y, 1, { instant });
      return;
    }
    const kept = neighbors.slice(0, Math.max(3, Math.ceil(neighbors.length * 0.75)));
    const points = [focus, ...kept];
    fitBounds(
      {
        minX: Math.min(...points.map((point) => point.x)),
        maxX: Math.max(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxY: Math.max(...points.map((point) => point.y)),
      },
      { instant, maxScale: 1.15, floor: 0.5 }
    );
  }

  function rememberView() {
    savedView = { scale: targetScale, offsetX: targetOffsetX, offsetY: targetOffsetY };
  }

  /* ---------------------------------------------------------------- 标签 */

  function labelMetrics(node, renderScale) {
    const fontScreen = clamp(11 * Math.sqrt(renderScale), 7.2, 12);
    return {
      fontScreen,
      widthScreen: labelOf(node).width * (fontScreen / 11),
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

  function nodeImportance(node) {
    if (node.id === focusId) return Number.POSITIVE_INFINITY;
    if (node.id === previewId || node.id === hoverId) return Number.MAX_SAFE_INTEGER;
    const listenScore = Math.log10((node.listens ?? 0) + 1) * 24;
    const listenerScore = Math.log10((node.listeners ?? 0) + 1) * 7;
    const relationScore = Math.log2((node.degree ?? 0) + 1) * 12;
    const regionalScore = node.regionalFeatured ? 28 : 0;
    return listenScore + listenerScore + relationScore + regionalScore;
  }

  function chooseRenderedLabels(view, display, displayMetrics, stageIndex) {
    const areaInMegapixels = viewportWidth * viewportHeight / 1_000_000;
    const configuredLimit = LABEL_LIMITS_PER_MEGAPIXEL[stageIndex];
    const limit = Number.isFinite(configuredLimit)
      ? Math.max(
          LABEL_LIMIT_FLOORS[stageIndex],
          Math.round(areaInMegapixels * configuredLimit)
        )
      : view.points.length;
    const gap = LABEL_GAPS[stageIndex];
    const candidates = [];

    for (const point of view.points) {
      const at = display.get(point.node.id);
      const metrics = displayMetrics(point.node);
      // 只剔除完全出屏的。原来是「碰到屏幕边 3px 就整块不画」，
      // 于是平移时边缘的名字是凭空闪没而不是滑出去。画布本来就会裁剪。
      if (
        at.screenX + metrics.widthScreen / 2 < -8 ||
        at.screenX - metrics.widthScreen / 2 > viewportWidth + 8 ||
        at.screenY + metrics.heightScreen / 2 < -8 ||
        at.screenY - metrics.heightScreen / 2 > viewportHeight + 8
      ) continue;
      const base = nodeImportance(point.node);
      candidates.push({
        id: point.node.id,
        metrics,
        priority: renderedLabels.has(point.node.id) ? base * LABEL_KEEP_BONUS : base,
        box: {
          left: at.screenX - metrics.widthScreen / 2 - gap,
          right: at.screenX + metrics.widthScreen / 2 + gap,
          top: at.screenY - metrics.heightScreen / 2 - gap,
          bottom: at.screenY + metrics.heightScreen / 2 + gap,
        },
      });
    }
    candidates.sort(
      (a, b) => b.priority - a.priority || hash(a.id) - hash(b.id)
    );

    const cellSize = 96;
    const grid = new Map();
    const labels = new Set();
    const metricsById = new Map();
    for (const candidate of candidates) {
      if (labels.size >= limit) break;
      const minX = Math.floor(candidate.box.left / cellSize);
      const maxX = Math.floor(candidate.box.right / cellSize);
      const minY = Math.floor(candidate.box.top / cellSize);
      const maxY = Math.floor(candidate.box.bottom / cellSize);
      let collides = false;
      for (let x = minX; x <= maxX && !collides; x += 1) {
        for (let y = minY; y <= maxY && !collides; y += 1) {
          for (const other of grid.get(`${x}:${y}`) || []) {
            if (
              candidate.box.left < other.right &&
              candidate.box.right > other.left &&
              candidate.box.top < other.bottom &&
              candidate.box.bottom > other.top
            ) {
              collides = true;
              break;
            }
          }
        }
      }
      if (collides) continue;
      labels.add(candidate.id);
      metricsById.set(candidate.id, candidate.metrics);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${x}:${y}`;
          const bucket = grid.get(key) || [];
          bucket.push(candidate.box);
          grid.set(key, bucket);
        }
      }
    }
    return { labels, metricsById };
  }

  /* ---------------------------------------------------------------- 绘制 */

  function dotRadiusOf(node) {
    return clamp(1.9 + Math.log2((node.degree ?? 0) + 1) * 0.28, 1.9, 4);
  }

  function render() {
    const stageIndex = activeStage;
    const stage = STAGES[stageIndex];
    const view = stageViews[stageIndex];
    if (!view) return;
    const fade = fadeStart
      ? clamp((performance.now() - fadeStart) / STAGE_FADE_MS, 0, 1)
      : 1;
    const zoomRatio = scale / stage.scale;
    const strokeRatio = clamp(zoomRatio, 0.72, 1.35);
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
      const minimumFont = stageIndex >= 2 ? 8.4 : 8.8;
      const fontScreen = clamp(metrics.fontScreen * zoomRatio, minimumFont, 14);
      const sizeRatio = fontScreen / metrics.fontScreen;
      return {
        fontScreen,
        widthScreen: metrics.widthScreen * sizeRatio,
        heightScreen: metrics.heightScreen * sizeRatio,
      };
    };
    const labelSelection = chooseRenderedLabels(view, display, displayMetrics, stageIndex);
    renderedLabels = labelSelection.labels;
    renderedMetrics = labelSelection.metricsById;

    const spotlight = previewId ?? hoverId;
    const spotlightNeighbors = spotlight
      ? new Set([spotlight, ...(adjacency.get(spotlight) || [])])
      : null;

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.fillStyle = '#0d1014';
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);

    /* 关系线 */
    const linkGroups = new Map();
    for (const link of view.links) {
      const weightBucket = Math.round(clamp(link.edge.weight ?? 0.5, 0, 1) * 3);
      const lit = spotlightNeighbors
        ? spotlightNeighbors.has(link.a.node.id) && spotlightNeighbors.has(link.b.node.id)
        : false;
      const key = `${link.edge.type}:${weightBucket}:${lit ? 1 : 0}`;
      const group = linkGroups.get(key) || [];
      group.push(link);
      linkGroups.set(key, group);
    }
    // 远景上千条线叠在一起会糊成雾，按阶段压一点透明度。
    const baseAlpha = stageIndex >= 3 ? 0.3 : stageIndex === 2 ? 0.42 : 0.56;
    for (const [key, group] of linkGroups) {
      const [type, bucketText, litText] = key.split(':');
      const weightBucket = Number(bucketText);
      const lit = litText === '1';
      ctx.strokeStyle = EDGE_COLORS[type] || '#96a4b4';
      const typeAlpha = type === 'scene' ? baseAlpha * 0.75 : baseAlpha;
      ctx.globalAlpha = lit ? 0.95 : spotlightNeighbors ? typeAlpha * 0.4 : typeAlpha;
      ctx.lineWidth = (0.75 + weightBucket * 0.34) * strokeRatio * (lit ? 1.7 : 1);
      ctx.setLineDash(
        type === 'feud'
          ? [6 * strokeRatio, 4 * strokeRatio]
          : type === 'scene'
            ? [1.5 * strokeRatio, 4 * strokeRatio]
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
        const fromMetrics = renderedMetrics.get(a.node.id) || {
          widthScreen: 7,
          heightScreen: 7,
        };
        const toMetrics = renderedMetrics.get(b.node.id) || {
          widthScreen: 7,
          heightScreen: 7,
        };
        const from = boundaryDistance(fromMetrics, ux, uy);
        const to = boundaryDistance(toMetrics, ux, uy);
        if (distance <= from + to) continue;
        ctx.moveTo(ap.screenX + ux * from, ap.screenY + uy * from);
        ctx.lineTo(bp.screenX - ux * to, bp.screenY - uy * to);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    /* 离场的点淡出 */
    if (fade < 1) {
      for (const point of fadeOutPoints) {
        const screenX = viewportWidth / 2 + offsetX + point.x * scale;
        const screenY = viewportHeight / 2 + offsetY + point.y * scale;
        if (
          screenX < -8 || screenX > viewportWidth + 8 ||
          screenY < -8 || screenY > viewportHeight + 8
        ) continue;
        ctx.beginPath();
        ctx.arc(screenX, screenY, dotRadiusOf(point.node), 0, Math.PI * 2);
        ctx.fillStyle = COLORS[point.node.region] || COLORS.unknown;
        ctx.globalAlpha = (1 - fade) * 0.6;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* 没轮到标签的点 */
    for (const point of view.points) {
      const at = display.get(point.node.id);
      if (renderedLabels.has(point.node.id)) continue;
      const dotRadius = dotRadiusOf(point.node);
      if (
        at.screenX + dotRadius < 0 ||
        at.screenX - dotRadius > viewportWidth ||
        at.screenY + dotRadius < 0 ||
        at.screenY - dotRadius > viewportHeight
      ) continue;
      const cold = popularOnly && (point.node.listens ?? 0) < MAP_POPULAR_LISTEN_FLOOR;
      const dim = spotlightNeighbors && !spotlightNeighbors.has(point.node.id);
      ctx.beginPath();
      ctx.arc(at.screenX, at.screenY, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[point.node.region] || COLORS.unknown;
      ctx.globalAlpha =
        (cold ? 0.34 : 0.72) *
        (dim ? 0.45 : 1) *
        (fadeInIds.has(point.node.id) ? fade : 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* 标签 */
    for (const point of view.points) {
      if (!renderedLabels.has(point.node.id)) continue;
      const at = display.get(point.node.id);
      const metrics = renderedMetrics.get(point.node.id);
      const selected = point.node.id === focusId;
      const lit = point.node.id === spotlight;
      const dim = spotlightNeighbors && !spotlightNeighbors.has(point.node.id);
      const color = COLORS[point.node.region] || COLORS.unknown;
      ctx.globalAlpha = (dim ? 0.5 : 1) * (fadeInIds.has(point.node.id) ? fade : 1);

      if (selected || lit) {
        // 焦点和悬停的节点给一圈光晕，一眼能找到自己在哪。
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = selected ? 18 : 12;
        roundedRect(
          ctx,
          at.screenX - metrics.widthScreen / 2,
          at.screenY - metrics.heightScreen / 2,
          metrics.widthScreen,
          metrics.heightScreen,
          clamp(8 * zoomRatio, 6, 11)
        );
        ctx.fillStyle = selected ? color : 'rgba(19,24,31,.98)';
        ctx.fill();
        ctx.restore();
      }

      roundedRect(
        ctx,
        at.screenX - metrics.widthScreen / 2,
        at.screenY - metrics.heightScreen / 2,
        metrics.widthScreen,
        metrics.heightScreen,
        clamp(8 * zoomRatio, 6, 11)
      );
      ctx.fillStyle = selected ? color : 'rgba(19,24,31,.94)';
      ctx.fill();
      ctx.strokeStyle = selected ? '#f3efe4' : color;
      ctx.lineWidth = (selected ? 2.2 : lit ? 1.9 : 1.15) * strokeRatio;
      ctx.stroke();
      ctx.fillStyle = selected ? '#101419' : '#ece8df';
      ctx.font = `${selected ? 650 : 520} ${metrics.fontScreen}px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 不传 maxWidth：宽度已经按实测算准，长名字在 labelOf 里就截断了。
      ctx.fillText(labelOf(point.node).text, at.screenX, at.screenY);
    }
    ctx.globalAlpha = 1;

    if (stats) {
      if (debug) {
        stats.textContent =
          `阶段 ${stageIndex + 1}/4 · 节点 ${view.visible.size} · 名称 ${renderedLabels.size}` +
          (popularOnly && stageIndex === STAGES.length - 1 ? ' · 远景隐藏冷门' : '');
      } else if (!stats.dataset.sticky) {
        stats.textContent = '';
      }
    }
    canvas.dataset.visibleNodes = String(view.visible.size);
    canvas.dataset.visibleLabels = String(renderedLabels.size);
    canvas.dataset.coldNodes = String(
      view.points.filter(
        (point) => (point.node.listens ?? 0) < MAP_POPULAR_LISTEN_FLOOR
      ).length
    );
    canvas.dataset.coldLabels = String(
      view.points.filter(
        (point) =>
          renderedLabels.has(point.node.id) &&
          (point.node.listens ?? 0) < MAP_POPULAR_LISTEN_FLOOR
      ).length
    );
    if (picker && picker.value !== focusId) picker.value = focusId;
    positionPreview();
    return fade < 1;
  }

  function frame(now) {
    renderFrame = 0;
    const moving = advanceCamera(now);
    const fading = render();
    if (moving || fading) requestRender();
    else lastFrameTime = 0;
  }

  function requestRender() {
    if (!renderFrame) renderFrame = requestAnimationFrame(frame);
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

  function chooseStage(screenX = viewportWidth / 2, screenY = viewportHeight / 2) {
    wantedStage = stageForScale(targetScale);
    if (wantedStage !== activeStage) {
      if (wantedStage < activeStage) prepareViewportStages(screenX, screenY);
      setStage(wantedStage);
    }
    requestRender();
  }

  /* ---------------------------------------------------------------- 命中 */

  function screenPoint(event) {
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * 命中优先级：写着名字的气泡永远赢过旁边裸着的点。
   * 光比距离的话，点在名字上却选中压在名字底下的小点，手感很莫名。
   * 没标签的点原来只有 9px 命中半径，而点本身才画 2–4px，触屏上基本点不中。
   */
  function hit(screenX, screenY, pad = HIT_PAD_MOUSE) {
    const view = stageViews[activeStage];
    if (!view) return null;
    let labelled = null;
    let labelledDistance = Infinity;
    let bare = null;
    let bareDistance = Infinity;
    for (const point of view.points) {
      const x = viewportWidth / 2 + offsetX + point.x * scale;
      const y = viewportHeight / 2 + offsetY + point.y * scale;
      const distance = Math.hypot(screenX - x, screenY - y);
      const metrics = renderedMetrics.get(point.node.id);
      if (metrics) {
        if (
          Math.abs(screenX - x) <= metrics.widthScreen / 2 + 4 &&
          Math.abs(screenY - y) <= metrics.heightScreen / 2 + 4 &&
          distance < labelledDistance
        ) {
          labelledDistance = distance;
          labelled = point.node;
        }
      } else if (
        distance <= Math.max(pad, dotRadiusOf(point.node) + pad * 0.5) &&
        distance < bareDistance
      ) {
        bareDistance = distance;
        bare = point.node;
      }
    }
    return labelled ?? bare;
  }

  function nodeScreenRect(id) {
    const point = positions?.get(id);
    if (!point) return null;
    const surfaceRect = surface.getBoundingClientRect();
    const x = viewportWidth / 2 + offsetX + point.x * scale;
    const y = viewportHeight / 2 + offsetY + point.y * scale;
    const metrics = renderedMetrics.get(id) || { widthScreen: 16, heightScreen: 16 };
    return {
      left: surfaceRect.left + x - metrics.widthScreen / 2,
      top: surfaceRect.top + y - metrics.heightScreen / 2,
      width: metrics.widthScreen,
      height: metrics.heightScreen,
    };
  }

  function gestureTarget(screenX, screenY) {
    const direct = hit(screenX, screenY, HIT_PAD_TOUCH);
    if (direct) return direct;
    let nearest = null;
    let nearestDistance = 86;
    for (const point of stageViews[activeStage].points) {
      const x = viewportWidth / 2 + offsetX + point.x * scale;
      const y = viewportHeight / 2 + offsetY + point.y * scale;
      const distance = Math.hypot(screenX - x, screenY - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = point.node;
      }
    }
    return nearest;
  }

  /* ---------------------------------------------------------------- 预览 */

  function positionPreview() {
    if (!preview || preview.hidden || !previewId) return;
    const point = positions.get(previewId);
    if (!point) return;
    const x = viewportWidth / 2 + offsetX + point.x * scale;
    const y = viewportHeight / 2 + offsetY + point.y * scale;
    const width = preview.offsetWidth || 240;
    const height = preview.offsetHeight || 120;
    const above = y - height - 22 > 8;
    preview.style.left = `${clamp(x - width / 2, 10, Math.max(10, viewportWidth - width - 10))}px`;
    preview.style.top = `${above ? y - height - 18 : Math.min(y + 20, viewportHeight - height - 10)}px`;
    preview.classList.toggle('map-preview--below', !above);
  }

  function showPreview(id) {
    if (!preview) {
      onChoose(id, { originRect: nodeScreenRect(id) });
      return;
    }
    previewId = id;
    const node = nodes.get(id);
    const band = describe?.(id);
    previewName.textContent = node?.name ?? id;
    const meta = [band?.area, band?.years].filter(Boolean).join(' · ');
    previewMeta.textContent = meta || (node?.region === 'east-asia' ? '东亚' : '');
    previewMeta.hidden = !previewMeta.textContent;
    const degree = node?.degree ?? (adjacency.get(id) || []).length;
    const listens = node?.listens ?? 0;
    previewCounts.textContent =
      `${degree} 条关系` + (listens ? ` · ${listens.toLocaleString('zh-CN')} 次收听` : '');
    preview.hidden = false;
    positionPreview();
    requestRender();
  }

  function hidePreview() {
    if (!preview || preview.hidden) return;
    preview.hidden = true;
    previewId = null;
    requestRender();
  }

  /* ---------------------------------------------------------------- 指针 */

  function beginPointer(event) {
    const point = screenPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 1) {
      drag = {
        ...point,
        rawX: targetOffsetX,
        rawY: targetOffsetY,
        moved: false,
        touch: event.pointerType === 'touch',
      };
      zoomAnchor = null;
      surface.style.cursor = 'grabbing';
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        startDistance: Math.hypot(a.x - b.x, a.y - b.y),
        allowReturn: true,
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
    drag = values.length
      ? { ...values[0], rawX: targetOffsetX, rawY: targetOffsetY, moved: values.length > 1, touch: true }
      : null;
    if (values.length === 2) {
      const [a, b] = values;
      pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        startDistance: Math.hypot(a.x - b.x, a.y - b.y),
        allowReturn: false,
      };
    }
  }

  function movePointer(event) {
    if (!pointers.has(event.pointerId)) {
      if (!drag && !pinch) updateHover(event);
      return;
    }
    const point = screenPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const startDistance = pinch?.startDistance ?? distance;
      const allowReturn = pinch?.allowReturn ?? false;
      if (allowReturn && distance / startDistance >= 1.55) {
        const target = gestureTarget(midX, midY);
        if (target) {
          const originRect = nodeScreenRect(target.id);
          pointers.clear();
          drag = null;
          pinch = null;
          onGestureChoose?.(target.id, { originRect, screenX: midX, screenY: midY });
          return;
        }
      }
      if (pinch?.distance) {
        // 双指同时缩放和平移：缩放钉在两指中点，平移跟中点走。
        targetScale = clamp(targetScale * distance / pinch.distance, minScale(), MAX_SCALE);
        scale = targetScale;
      }
      const worldX = ((pinch?.midX ?? midX) - viewportWidth / 2 - offsetX) / scale;
      const worldY = ((pinch?.midY ?? midY) - viewportHeight / 2 - offsetY) / scale;
      offsetX = midX - viewportWidth / 2 - worldX * scale;
      offsetY = midY - viewportHeight / 2 - worldY * scale;
      targetOffsetX = offsetX;
      targetOffsetY = offsetY;
      zoomAnchor = null;
      pinch = { distance, midX, midY, startDistance, allowReturn };
      if (drag) drag.moved = true;
      chooseStage(midX, midY);
      return;
    }
    if (drag) {
      drag.rawX += point.x - drag.x;
      drag.rawY += point.y - drag.y;
      drag.x = point.x;
      drag.y = point.y;
      if (!drag.moved && Math.hypot(drag.rawX - targetOffsetX, drag.rawY - targetOffsetY) < 4) {
        return;
      }
      drag.moved = true;
      offsetX = rubber(drag.rawX, clampOffsetX(drag.rawX));
      offsetY = rubber(drag.rawY, clampOffsetY(drag.rawY));
      targetOffsetX = offsetX;
      targetOffsetY = offsetY;
      maybeRebuildStages();
      requestRender();
    }
  }

  function updateHover(event) {
    if (!stageViews[activeStage]) return;
    const point = screenPoint(event);
    const node = hit(point.x, point.y, HIT_PAD_MOUSE);
    const nextId = node?.id ?? null;
    surface.style.cursor = nextId ? 'pointer' : 'grab';
    if (nextId === hoverId) return;
    hoverId = nextId;
    requestRender();
  }

  function endPointer(event) {
    const point = screenPoint(event);
    pointers.delete(event.pointerId);
    const tapped = Boolean(!pointers.size && drag && !drag.moved);
    let chosen = null;
    if (tapped) {
      chosen = hit(point.x, point.y, drag.touch ? HIT_PAD_TOUCH : HIT_PAD_MOUSE);
    }
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      drag = { ...remaining, rawX: targetOffsetX, rawY: targetOffsetY, moved: true, touch: drag?.touch };
    } else if (!pointers.size) {
      drag = null;
      surface.style.cursor = hoverId ? 'pointer' : 'grab';
      settleCamera(); // 越界的部分回弹
      maybeRebuildStages();
    }
    pinch = null;
    if (chosen) showPreview(chosen.id);
    else if (tapped && event.type === 'pointerup') hidePreview();
    rememberView();
  }

  /* ---------------------------------------------------------------- 事件 */

  surface.addEventListener('pointerdown', (event) => {
    if (event.target.closest?.('.network-map__hud, .map-preview, .network-map__foot')) return;
    surface.setPointerCapture(event.pointerId);
    beginPointer(event);
  });
  surface.addEventListener('pointermove', movePointer);
  surface.addEventListener('pointerup', endPointer);
  surface.addEventListener('pointercancel', endPointer);
  surface.addEventListener('pointerleave', () => {
    if (hoverId) {
      hoverId = null;
      requestRender();
    }
  });

  /**
   * 滚轮语义。
   *
   * 原来是「任何 wheel 事件都缩放」，于是 Mac 触控板两指一滑就是疯狂缩放——
   * 触控板上两指滑动是平移，捏合才是缩放（浏览器把捏合报成 ctrlKey+wheel）。
   * 剩下的鼠标滚轮按老规矩缩放：真滚轮的 deltaY 是 100/120 这种大整数且没有横向分量，
   * 用这个区分触控板和滚轮。
   */
  surface.addEventListener(
    'wheel',
    (event) => {
      if (event.target.closest?.('.network-map__hud, .map-preview, .network-map__foot')) return;
      event.preventDefault();
      const point = screenPoint(event);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
      const deltaX = event.deltaX * unit;
      const deltaY = event.deltaY * unit;
      const wheelLike =
        deltaX === 0 && Math.abs(deltaY) >= 100 && Number.isInteger(event.deltaY);
      if (event.ctrlKey || event.metaKey || wheelLike) {
        zoomAt(targetScale * Math.exp(-deltaY * 0.0022), point.x, point.y);
      } else {
        panBy(-deltaX, -deltaY);
        maybeRebuildStages();
      }
      rememberView();
    },
    { passive: false }
  );

  surface.addEventListener('dblclick', (event) => {
    if (event.target.closest?.('.network-map__hud, .map-preview, .network-map__foot')) return;
    const point = screenPoint(event);
    const node = hit(point.x, point.y, HIT_PAD_MOUSE);
    if (node) {
      hidePreview();
      onChoose(node.id, { originRect: nodeScreenRect(node.id) });
    } else if (worldBounds) {
      hidePreview();
      fitBounds(worldBounds, { maxScale: 1 });
      prepareViewportStages();
    }
  });

  canvas.addEventListener('keydown', (event) => {
    const move = 96;
    if (event.key === 'ArrowLeft') panBy(move, 0);
    else if (event.key === 'ArrowRight') panBy(-move, 0);
    else if (event.key === 'ArrowUp') panBy(0, move);
    else if (event.key === 'ArrowDown') panBy(0, -move);
    else if (event.key === '+' || event.key === '=') {
      zoomAt(targetScale * 1.28, viewportWidth / 2, viewportHeight / 2);
    } else if (event.key === '-' || event.key === '_') {
      zoomAt(targetScale / 1.28, viewportWidth / 2, viewportHeight / 2);
    } else if (event.key === 'Enter' && previewId) {
      onChoose(previewId, { originRect: nodeScreenRect(previewId) });
    } else if (event.key === 'Escape') {
      if (previewId) hidePreview();
      else document.getElementById('map-close')?.click();
      return;
    } else if (event.key === 'Home') {
      goHome();
    } else {
      return;
    }
    maybeRebuildStages();
    rememberView();
    event.preventDefault();
  });

  picker?.addEventListener('change', () => {
    if (picker.value) recenter(picker.value);
  });
  popularToggle?.addEventListener('click', async () => {
    await setPopularOnly(!popularOnly);
    onPopularChange?.(popularOnly);
    canvas.focus();
  });
  homeButton?.addEventListener('click', () => {
    goHome();
    canvas.focus();
  });
  zoomInButton?.addEventListener('click', () => {
    zoomAt(targetScale * 1.4, viewportWidth / 2, viewportHeight / 2);
    rememberView();
  });
  zoomOutButton?.addEventListener('click', () => {
    zoomAt(targetScale / 1.4, viewportWidth / 2, viewportHeight / 2);
    rememberView();
  });
  previewEnter?.addEventListener('click', () => {
    if (previewId) onChoose(previewId, { originRect: nodeScreenRect(previewId) });
  });
  previewCenter?.addEventListener('click', () => {
    if (previewId) recenter(previewId);
  });
  previewClose?.addEventListener('click', hidePreview);

  function goHome() {
    const anchor = positions.get(focusId) || positions.get(cardId);
    if (!anchor) return;
    hidePreview();
    fitNeighborhood(focusId ?? cardId);
    prepareViewportStages();
    rememberView();
  }

  // 在地图里换中心：不离开地图，只是把注意力挪过去，方便一路走下去。
  function recenter(id) {
    if (!positions.has(id)) return;
    focusId = id;
    hidePreview();
    prepareFocus(id);
    fitNeighborhood(id);
    prepareViewportStages();
    rememberView();
  }

  async function setPopularOnly(enabled, { rebuild = true } = {}) {
    const next = Boolean(enabled);
    const changed = next !== popularOnly;
    popularOnly = next;
    popularToggle?.setAttribute('aria-pressed', String(popularOnly));
    if (popularToggle) popularToggle.textContent = `远景精简：${popularOnly ? '开' : '关'}`;
    if (!focusId || !changed || !rebuild) return;
    prepareFocus(focusId);
    sizeCanvas();
    requestRender();
  }

  function handleResize() {
    if (!focusId) return;
    sizeCanvas();
    if (pendingFit && viewportWidth > 1 && viewportHeight > 1) {
      const id = pendingFit;
      pendingFit = null;
      fitNeighborhood(id, { instant: true });
      activeStage = stageForScale(targetScale, 0);
      wantedStage = activeStage;
    }
    settleCamera();
    prepareViewportStages();
    render();
  }

  // 窗口 resize 不覆盖「地图在尺寸为 0 时被打开」这一类情况，直接盯住画布本身。
  new ResizeObserver(handleResize).observe(surface);

  if (legendBox && window.innerWidth < 760) legendBox.open = false;

  return {
    async open(id) {
      await load();
      cardId = id;
      focusId = id;
      hidePreview();
      hoverId = null;
      sizeCanvas();
      // 后台标签页或刚恢复的窗口里 clientWidth 会是 0，这时候算出来的取景是废的。
      // 记下来，等 ResizeObserver 报出真实尺寸再补一次。
      pendingFit = viewportWidth < 2 || viewportHeight < 2 ? id : null;
      const focus = positions.get(id);
      if (savedView) {
        // 回到上次离开时的视野；焦点要是不在屏内，保持缩放级别把它挪进来。
        targetScale = clamp(savedView.scale, minScale(), MAX_SCALE);
        scale = targetScale;
        offsetX = targetOffsetX = clampOffsetX(savedView.offsetX, scale);
        offsetY = targetOffsetY = clampOffsetY(savedView.offsetY, scale);
        const screenX = viewportWidth / 2 + offsetX + focus.x * scale;
        const screenY = viewportHeight / 2 + offsetY + focus.y * scale;
        const insetX = viewportWidth * 0.12;
        const insetY = viewportHeight * 0.12;
        if (
          screenX < insetX || screenX > viewportWidth - insetX ||
          screenY < insetY || screenY > viewportHeight - insetY
        ) {
          flyTo(focus.x, focus.y, targetScale, { instant: true });
        }
      } else {
        fitNeighborhood(id, { instant: true });
      }
      zoomAnchor = null;
      activeStage = stageForScale(targetScale, 0);
      wantedStage = activeStage;
      fadeStart = 0;
      fadeInIds = new Set();
      fadeOutPoints = [];
      prepareFocus(id);
      rememberView();
      surface.style.cursor = 'grab';
      render();
    },
    resize: handleResize,
    setPopularOnly,
    getFocusRect() {
      if (!cardId) return null;
      const rect = nodeScreenRect(cardId);
      if (!rect) return null;
      const surfaceRect = surface.getBoundingClientRect();
      const inside =
        rect.left > surfaceRect.left - rect.width &&
        rect.left < surfaceRect.right &&
        rect.top > surfaceRect.top - rect.height &&
        rect.top < surfaceRect.bottom;
      return inside ? rect : null;
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
