import { loadIndex, loadBand, isLoaded, prefetchNeighbors, REL } from './data.js';
import { layoutNeighbors } from './layout.js';
import { createNetworkMap } from './map.js?v=600e85e036';
import {
  buildFocusCard,
  buildPeekCard,
  buildRelChip,
  buildEdgeLayer,
  buildEdgeLine,
  CANVAS_HALF,
} from './render.js';

const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
const sceneEl = document.getElementById('scene-name');

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const PAN_MS = 680;

let index = null;
let world = null;
let current = null; // 当前焦点乐队文档
let slots = []; // 当前邻居槽位
let busy = false;
let neighborSelectionSalt = 0;
const mapEl = document.getElementById('network-map');
const mapCanvas = document.getElementById('network-canvas');
const mapStats = document.getElementById('map-stats');
const mapError = document.getElementById('map-error');
const mapOpenButton = document.getElementById('map-open');
let mapReturnFocus = null;
const networkMap = createNetworkMap({
  canvas: mapCanvas,
  onChoose: (id) => {
    hideNetworkMap();
    jumpTo(id);
  },
});

function hideNetworkMap({ restoreFocus = true } = {}) {
  stageTouches.clear();
  mapGestureActive = false;
  networkMap.cancelPointers();
  mapEl.hidden = true;
  if (restoreFocus) mapReturnFocus?.focus();
}

async function showNetworkMap({ trigger = mapOpenButton, preservePointers = false } = {}) {
  if (!current) return;
  mapReturnFocus = trigger;
  mapEl.hidden = false;
  mapError.hidden = true;
  mapStats.textContent = '载入地图…';
  if (!preservePointers) networkMap.cancelPointers();
  try {
    await networkMap.open(current.id);
    if (!preservePointers) mapCanvas.focus();
  } catch (error) {
    console.error(error);
    mapStats.textContent = '地图不可用';
    mapError.hidden = false;
  }
}

document.getElementById('map-close').addEventListener('click', () => {
  hideNetworkMap();
});
mapOpenButton.addEventListener('click', (event) => showNetworkMap({ trigger: event.currentTarget }));
document.getElementById('map-retry').addEventListener('click', () =>
  showNetworkMap({ trigger: mapReturnFocus })
);
window.addEventListener('resize', () => { if (!mapEl.hidden) networkMap.resize(); });

/* ------------------------------------------------------------------ 相机 */

/**
 * 等到浏览器认下了元素的初始状态，再切到目标状态，动画才会跑起来。
 * 用 rAF 是正路，但后台标签页里 rAF 根本不触发——那样起始态就永远摘不掉，
 * 页面会停在「全部透明」的样子。所以再挂一个定时器兜底。
 */
function nextFrame(fn) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, 100);
}

function cameraTransform(x, y) {
  return `translate3d(${-x}px, ${-y}px, 0)`;
}

function panCamera(x, y, from = { x: 0, y: 0 }) {
  if (reduceMotion.matches) {
    world.style.transform = cameraTransform(x, y);
    return Promise.resolve();
  }
  const anim = world.animate(
    [{ transform: cameraTransform(from.x, from.y) }, { transform: cameraTransform(x, y) }],
    { duration: PAN_MS, easing: 'cubic-bezier(.72,0,.16,1)', fill: 'forwards' }
  );
  // 光等 finished 不行：标签页在后台时动画根本不推进，promise 永远不兑现，
  // 导航就会卡死在半路（busy 一直是 true，之后所有点击都被吞掉）。
  const bailout = new Promise((r) => setTimeout(r, PAN_MS + 150));
  return Promise.race([anim.finished.catch(() => {}), bailout]).then(() => {
    world.style.transform = cameraTransform(x, y);
    anim.cancel();
  });
}

/* ---------------------------------------------------------------- 渲染 */

function viewport() {
  return { vw: stage.clientWidth, vh: stage.clientHeight };
}

function makeNode(className, x, y, angle) {
  const node = document.createElement('div');
  node.className = `node ${className}`;
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  if (angle != null) {
    node.style.setProperty('--ux', Math.cos(angle).toFixed(4));
    node.style.setProperty('--uy', Math.sin(angle).toFixed(4));
  }
  return node;
}

/**
 * 把世界整个重建一遍：焦点回到原点，相机归零。
 * 这一步永远发生在相机已经停在目标身上的时刻，画面内容一致，所以看不出偷换。
 */
function render(band, { cameFrom, backAngle, animate = true, reuseSelection = false } = {}) {
  const { vw, vh } = viewport();
  laidOutFor = { vw, vh };
  if (!reuseSelection) neighborSelectionSalt += 1;
  slots = layoutNeighbors(band.id, band.edges, {
    cameFrom,
    backAngle,
    vw,
    vh,
    selectionSalt: neighborSelectionSalt,
  });

  const next = document.createElement('div');
  next.className = 'world';
  next.style.transform = cameraTransform(0, 0);

  const edgeLayer = buildEdgeLayer();
  next.append(edgeLayer);

  const focusNode = makeNode('node--focus', 0, 0);
  focusNode.append(buildFocusCard(band));
  next.append(focusNode);

  for (const slot of slots) {
    edgeLayer.append(buildEdgeLine(slot));

    const chipNode = makeNode('node--chip', 0, 0);
    chipNode.append(buildRelChip(slot));
    next.append(chipNode);

    const node = makeNode('node--peek', slot.x, slot.y, slot.angle);
    node.append(buildPeekCard(slot));
    next.append(node);
    slot.node = node;
    slot.chip = chipNode;
  }

  if (world) world.remove();
  world = next;
  stage.append(world);
  placeChips(focusNode.firstElementChild);

  stage.classList.remove('is-traveling');
  current = band;

  if (animate && !reduceMotion.matches) {
    stage.classList.add('is-entering');
    nextFrame(() => stage.classList.remove('is-entering'));
  }

  document.title = `${band.name} · 乐队关系网`;
  setStatus(band);
  prefetchNeighbors(band);
}

/** 盒子在某个方向上的投影长度。 */
function projectSize(box, dx, dy) {
  return Math.abs(dx) * box.width + Math.abs(dy) * box.height;
}

const CHIP_CLEARANCE = 12;

/**
 * 关系标签贴在连线上，从焦点卡片的外缘往外挂。
 *
 * 挂而不是居中，是因为标签悬停时会多出一整句说明：从边缘往外长，
 * 长出去的部分落在空白里；居中的话两头都长，靠内那半截会钻到焦点卡片底下。
 *
 * 左右两条边够长，挂得下；上下两条边则不然——焦点卡片几乎顶到视口上下沿，
 * 和邻居卡片之间根本没有缝。那种情况就把标签收起来，改由邻居卡片自己写出关系。
 */
function placeChips(focusCard) {
  const focus = focusCard.getBoundingClientRect();

  for (const slot of slots) {
    const dx = Math.cos(slot.angle);
    const dy = Math.sin(slot.angle);

    const tx = Math.abs(dx) < 1e-6 ? Infinity : focus.width / 2 / Math.abs(dx);
    const ty = Math.abs(dy) < 1e-6 ? Infinity : focus.height / 2 / Math.abs(dy);
    const exit = Math.min(tx, ty); // 射线离开焦点卡片处
    const enter = slot.radius - projectSize(slot.node.getBoundingClientRect(), dx, dy) / 2;

    // 量展开后的尺寸：收起时放得下、一展开就撞车的位置，不如一开始就别放。
    slot.chip.classList.add('is-hot');
    const reach = projectSize(slot.chip.getBoundingClientRect(), dx, dy);
    slot.chip.classList.remove('is-hot');

    const d = exit + CHIP_CLEARANCE;
    if (d + reach > enter - CHIP_CLEARANCE) {
      slot.chip.hidden = true;
      slot.node.querySelector('.card--peek').classList.add('show-label');
      continue;
    }

    slot.chip.style.left = `${(dx * d).toFixed(1)}px`;
    slot.chip.style.top = `${(dy * d).toFixed(1)}px`;
    slot.chip.classList.add(
      Math.abs(dx) > 0.35 ? (dx > 0 ? 'anchor-e' : 'anchor-w') : dy > 0 ? 'anchor-s' : 'anchor-n'
    );
  }
}

function setStatus(band) {
  const shown = slots.length;
  const total = band.edges.length;
  if (total <= 1) {
    statusEl.textContent = `${band.name} 目前只有 ${total} 条关系 — 数据还很浅`;
  } else if (shown < total) {
    statusEl.textContent = `边缘显示 ${shown} / ${total} 条关系，其余在卡片内`;
  } else {
    statusEl.textContent = `${total} 条关系`;
  }
}

/* -------------------------------------------------------------- 导航 */

/**
 * 点击边缘卡片：相机滑过去，目标在途中展开成新的焦点。
 * from 是相机此刻已经被拖到的位置——手势松手时画布不在原点，
 * 不从那里接着动的话会先跳回去再滑，很难看。
 */
async function travelTo(slot, from = { x: 0, y: 0 }) {
  if (busy) return;
  busy = true;
  try {
    const target = await loadBand(slot.edge.to);
    setRoute(target.id);

    stage.classList.add('is-traveling');
    slot.node.classList.add('is-target');
    slot.chip.classList.add('is-target');

    const peek = slot.node.querySelector('.card--peek');
    const arriving = buildFocusCard(target);
    arriving.classList.add('card--arriving');
    slot.node.append(arriving);
    peek.classList.add('is-leaving');
    nextFrame(() => arriving.classList.remove('card--arriving'));

    await panCamera(slot.x, slot.y, from);
    render(target, { cameFrom: current.id, backAngle: slot.angle + Math.PI });
  } catch (err) {
    console.error(err);
    statusEl.textContent = '加载失败，请重试';
    stage.classList.remove('is-traveling');
  } finally {
    busy = false;
  }
}

/** 没有来路方向时的跳转（随机、地址栏、卡片内的关系列表）：交叉淡入。 */
async function jumpTo(id, { push = true } = {}) {
  if (busy) return;
  busy = true;
  try {
    if (!isLoaded(id)) statusEl.textContent = '载入中…';
    const band = await loadBand(id);
    if (push) setRoute(band.id);
    stage.classList.add('is-fading');
    if (!reduceMotion.matches) await wait(220);
    render(band);
    stage.classList.remove('is-fading');
  } catch (err) {
    console.error(err);
    statusEl.textContent = '加载失败，请重试';
    stage.classList.remove('is-fading');
  } finally {
    busy = false;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进站随机：只从关系够多的乐队里挑，避免一开局就是死胡同。 */
function randomId(exclude) {
  const candidates = index.bands.filter((band) => band.id !== exclude);
  const strong = candidates.filter(
    (band) =>
      band.degree >= 3 &&
      !band.quality?.templateIntro &&
      (band.quality?.score ?? 0) >= 38
  );
  const pool = strong.length >= 40
    ? strong
    : candidates.filter((band) => band.degree >= 3);
  const maxListens = Math.max(1, ...pool.map((band) => band.listens ?? 0));
  const weights = pool.map((band) => {
    const popularity = Math.log1p(band.listens ?? 0) / Math.log1p(maxListens);
    const content = (band.quality?.score ?? 25) / 100;
    const connected = Math.min(band.degree, 16) / 16;
    const eastAsia = band.region === 'east-asia' ? 1.28 : 1;
    return (0.08 + popularity * 3.4 + content * 1.9 + connected * 0.7) * eastAsia;
  });
  let ticket = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < pool.length; index += 1) {
    ticket -= weights[index];
    if (ticket <= 0) return pool[index].id;
  }
  return pool.at(-1)?.id ?? candidates[0].id;
}

function idFromHash() {
  const m = location.hash.match(/^#\/band\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 地址栏同步是锦上添花：分享出去的链接能直达某支乐队。
 * 但沙箱里的 iframe 调 history API 会直接抛 SecurityError，
 * 不兜住的话整个导航都会跟着失败。
 */
function setRoute(id, { replace = false } = {}) {
  try {
    history[replace ? 'replaceState' : 'pushState'](null, '', `#/band/${id}`);
  } catch {
    /* 宿主不给写历史记录，那就不写，不影响走网 */
  }
}

/* -------------------------------------------------------------- 事件 */

stage.addEventListener('click', (ev) => {
  // 触屏划完一下还会补发一个 click，别让它再触发一次跳转
  if (swallowClick) {
    swallowClick = false;
    return;
  }
  const peek = ev.target.closest('.card--peek');
  if (peek) {
    const slot = slots.find((s) => s.edge.to === peek.dataset.id);
    if (slot) travelTo(slot);
    return;
  }
  const row = ev.target.closest('.rel-row');
  if (row) {
    const slot = slots.find((s) => s.edge.to === row.dataset.id);
    if (slot) travelTo(slot);
    else jumpTo(row.dataset.id);
  }
});

// 悬停边缘卡片时，对应的连线与关系标签一起点亮。
stage.addEventListener('pointerover', (ev) => {
  const peek = ev.target.closest('.card--peek');
  if (peek) setHighlight(peek.dataset.id, true);
});
stage.addEventListener('pointerout', (ev) => {
  const peek = ev.target.closest('.card--peek');
  if (peek) setHighlight(peek.dataset.id, false);
});
stage.addEventListener('focusin', (ev) => {
  const peek = ev.target.closest('.card--peek');
  if (peek) setHighlight(peek.dataset.id, true);
});
stage.addEventListener('focusout', (ev) => {
  const peek = ev.target.closest('.card--peek');
  if (peek) setHighlight(peek.dataset.id, false);
});

/* -------------------------------------------------------------- 手势 */

/**
 * 触屏上拖画布换乐队。
 *
 * 方向约定跟地图 app 一致：手指往上滑 = 把下面那张卡片拽上来。
 * 也就是说想去的那支乐队，在手指划过方向的**反面**。
 *
 * 松手时按方向匹配最接近的邻居，所以斜着滑能挑出上边缘偏左还是偏右那一张——
 * 这正是窄屏上下各摆两张时需要的。
 */
const SWIPE_MIN = 56; // 小于这个距离当误触
const SWIPE_ARC = Math.PI / 3; // 方向偏差超过 60° 就不认
const DRAG_DAMP = 0.42; // 画布跟手但带阻尼，暗示这不是自由拖动

let drag = null;
let swallowClick = false;
const stageTouches = new Map();
let mapGestureActive = false;

function openMapFromGesture() {
  if (mapEl.hidden) {
    drag = null;
    mapGestureActive = true;
    mapEl.hidden = false;
    mapReturnFocus = null;
    mapError.hidden = true;
    mapStats.textContent = '载入地图…';
    networkMap.adoptPointers(
      [...stageTouches.entries()].map(([id, point]) => ({ id, ...point }))
    );
    showNetworkMap({ trigger: null, preservePointers: true });
  }
}

function pickSlotToward(angle) {
  let best = null;
  let bestDelta = SWIPE_ARC;
  for (const slot of slots) {
    let d = Math.abs(((slot.angle - angle + Math.PI) % (Math.PI * 2)) - Math.PI);
    if (d < bestDelta) {
      bestDelta = d;
      best = slot;
    }
  }
  return best;
}

stage.addEventListener(
  'pointerdown',
  (ev) => {
    if (ev.pointerType === 'mouse' || busy || !world) return;
    if (ev.pointerType === 'touch') {
      stageTouches.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });
      // 第二根手指落下就从卡片自然退到关系网，不需要额外的「全网」入口。
      if (stageTouches.size >= 2) {
        stage.setPointerCapture?.(ev.pointerId);
        return openMapFromGesture();
      }
    }
    // 焦点卡片正文自己要滚动，别把它的竖划抢走
    if (ev.target.closest('.card__body, .search')) return;
    // 接住这根手指直到松开。否则手指划出舞台边缘时收不到 pointerup，
    // 下一次触摸会带着上一次的拖动状态继续，画面就像卡住了一样。
    stage.setPointerCapture?.(ev.pointerId);
    drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, dx: 0, dy: 0, active: false };
  },
  { passive: true }
);

stage.addEventListener(
  'pointermove',
  (ev) => {
    if (mapGestureActive && stageTouches.has(ev.pointerId)) {
      stageTouches.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });
      networkMap.moveAdoptedPointer(ev);
      return;
    }
    if (!drag || ev.pointerId !== drag.id) return;
    drag.dx = ev.clientX - drag.x0;
    drag.dy = ev.clientY - drag.y0;
    if (!drag.active && Math.hypot(drag.dx, drag.dy) < 10) return;
    drag.active = true;
    world.style.transition = 'none';
    world.style.transform = `translate3d(${drag.dx * DRAG_DAMP}px, ${drag.dy * DRAG_DAMP}px, 0)`;
  },
  { passive: true }
);

function endDrag(ev) {
  if (mapGestureActive) return;
  if (!drag || ev.pointerId !== drag.id) return;
  const { dx, dy, active } = drag;
  drag = null;
  if (stage.hasPointerCapture?.(ev.pointerId)) stage.releasePointerCapture(ev.pointerId);
  if (!active) return;
  // 只有正常松手才会紧跟一个合成 click；被系统取消（来电、切换 app 等）时
  // 不吞掉下一次真正的点击。
  swallowClick = ev.type !== 'pointercancel';

  // 画布此刻停在哪儿。相机坐标和位移是反的：画布右移 = 相机左移。
  const from = { x: -dx * DRAG_DAMP, y: -dy * DRAG_DAMP };
  const target = Math.hypot(dx, dy) >= SWIPE_MIN ? pickSlotToward(Math.atan2(-dy, -dx)) : null;

  if (target) {
    world.style.transform = cameraTransform(from.x, from.y);
    travelTo(target, from);
  } else {
    // 没够着任何一张，弹回去
    world.style.transition = 'transform .34s cubic-bezier(.2,.9,.25,1)';
    world.style.transform = cameraTransform(0, 0);
    setTimeout(() => world && (world.style.transition = ''), 360);
  }
}

stage.addEventListener('pointerup', endDrag, { passive: true });
stage.addEventListener('pointercancel', endDrag, { passive: true });
function endStageTouch(ev) {
  if (mapGestureActive && stageTouches.has(ev.pointerId)) {
    networkMap.endAdoptedPointer(ev);
  }
  stageTouches.delete(ev.pointerId);
  if (!stageTouches.size) mapGestureActive = false;
  if (stage.hasPointerCapture?.(ev.pointerId)) stage.releasePointerCapture(ev.pointerId);
}
stage.addEventListener('pointerup', endStageTouch, { passive: true });
stage.addEventListener('pointercancel', endStageTouch, { passive: true });

function setHighlight(id, on) {
  const slot = slots.find((s) => s.edge.to === id);
  if (!slot) return;
  slot.node.classList.toggle('is-hot', on);
  slot.chip.classList.toggle('is-hot', on);
  world.querySelectorAll('.edge').forEach((line, i) => {
    if (slots[i] === slot) line.classList.toggle('is-hot', on);
  });
}

document.getElementById('shuffle').addEventListener('click', () => {
  jumpTo(randomId(current?.id));
});

/* -------------------------------------------------------------- 搜索 */

const searchEl = document.getElementById('search');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let hits = [];
let cursor = 0;

function openSearch() {
  searchEl.hidden = false;
  searchInput.value = '';
  runSearch('');
  searchInput.focus();
}

function closeSearch() {
  searchEl.hidden = true;
}

/**
 * 名字前缀最优先，其次名字里包含，最后才是地区命中。
 * 输入为空时给几支关系最密的当入口，而不是空着一片。
 */
function runSearch(raw) {
  const q = raw.trim().toLowerCase();
  const pool = index?.bands ?? [];

  if (!q) {
    hits = [...pool].sort((a, b) => b.degree - a.degree).slice(0, 8);
  } else {
    hits = pool
      .map((b) => {
        const name = b.name.toLowerCase();
        if (name.startsWith(q)) return { b, rank: 0 };
        if (name.includes(q)) return { b, rank: 1 };
        if ((b.area ?? '').toLowerCase().includes(q)) return { b, rank: 2 };
        return null;
      })
      .filter(Boolean)
      .sort((x, y) => x.rank - y.rank || y.b.degree - x.b.degree)
      .slice(0, 12)
      .map((x) => x.b);
  }

  cursor = 0;
  searchResults.replaceChildren();
  if (!hits.length) {
    const li = document.createElement('li');
    li.className = 'search__empty';
    li.textContent = '没有找到这支乐队';
    searchResults.append(li);
    return;
  }
  hits.forEach((b, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search__hit';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(i === cursor));
    btn.dataset.id = b.id;

    const name = document.createElement('span');
    name.className = 'search__hit-name';
    name.textContent = b.name;
    const meta = document.createElement('span');
    meta.className = 'search__hit-meta';
    meta.textContent = [b.area, `${b.degree} 条关系`].filter(Boolean).join(' · ');

    btn.append(name, meta);
    li.append(btn);
    searchResults.append(li);
  });
}

function moveCursor(delta) {
  if (!hits.length) return;
  cursor = (cursor + delta + hits.length) % hits.length;
  const options = searchResults.querySelectorAll('.search__hit');
  options.forEach((o, i) => o.setAttribute('aria-selected', String(i === cursor)));
  options[cursor]?.scrollIntoView({ block: 'nearest' });
}

document.getElementById('search-open').addEventListener('click', openSearch);
searchInput.addEventListener('input', () => runSearch(searchInput.value));

searchEl.addEventListener('click', (ev) => {
  // 点浮层的空白处关掉；点到结果就跳过去
  const hit = ev.target.closest('.search__hit');
  if (hit) {
    closeSearch();
    jumpTo(hit.dataset.id);
  } else if (!ev.target.closest('.search__panel')) {
    closeSearch();
  }
});

searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    moveCursor(1);
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    moveCursor(-1);
  } else if (ev.key === 'Enter' && hits[cursor]) {
    closeSearch();
    jumpTo(hits[cursor].id);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !searchEl.hidden) return closeSearch();
  // 「/」是常见的搜索快捷键；正在输入的时候不抢
  if (ev.key === '/' && searchEl.hidden && !/^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) {
    ev.preventDefault();
    openSearch();
  }
});

window.addEventListener('hashchange', () => {
  const id = idFromHash();
  if (id && id !== current?.id) jumpTo(id, { push: false });
});

// 邻居的位置整个是按视口尺寸算出来的，尺寸一变就得重排。
// 用 ResizeObserver 而不是 window 的 resize 事件：舞台的尺寸变化未必伴随一次
// window resize（页面在隐藏的小画布里先渲染一遍就是这种情况），漏掉的话
// 邻居会按错误的尺寸摆在焦点卡片背后，一张都看不见。
let laidOutFor = { vw: 0, vh: 0 };
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const { vw, vh } = viewport();
    if (!current || busy) return;
    if (Math.abs(vw - laidOutFor.vw) < 24 && Math.abs(vh - laidOutFor.vh) < 24) return;
    render(current, { animate: false, reuseSelection: true });
  }, 140);
}).observe(stage);

/* -------------------------------------------------------------- 启动 */

(async function boot() {
  try {
    index = await loadIndex();
    sceneEl.textContent = index.scene;
    const legend = document.getElementById('legend');
    for (const [type, meta] of Object.entries(REL)) {
      const li = document.createElement('li');
      li.className = `legend__item rel-${type}`;
      li.innerHTML = `<i></i>${meta.name}`;
      legend.append(li);
    }
    const id = idFromHash() ?? randomId();
    const band = await loadBand(id).catch(() => loadBand(randomId()));
    if (!idFromHash()) setRoute(band.id, { replace: true });
    render(band);
  } catch (err) {
    console.error(err);
    statusEl.textContent = '数据加载失败：请先运行 node tools/build-data.mjs';
  }
})();
