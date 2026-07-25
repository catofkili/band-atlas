/**
 * 以焦点为中心的局部布局（ego layout）。
 *
 * 世界坐标原点永远是当前焦点乐队。邻居沿着视口边框铺开，卡片中心压在边界附近，
 * 于是每张都被屏幕切掉一半 —— 这是整个交互的钩子：一眼就能看出画布还在屏幕外延伸。
 */

/** FNV-1a，用来给布局一个稳定的随机性：同一支乐队每次进来方位一致。 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const TAU = Math.PI * 2;

/** 邻居上限：窄屏边缘位置少，露出的卡片也要少。 */
export function maxNeighbors(vw) {
  if (vw < 560) return 4;
  if (vw < 900) return 5;
  if (vw < 1400) return 7;
  return 8;
}

/**
 * 槽位沿视口边框的周长分布，而不是按角度均分整圈。
 * 按角度分会出问题：宽屏上「离垂直方向 26°」在水平方向只有几十像素，
 * 上下两张卡片会挤在焦点卡片正后方。按边长分则天然贴着边均匀铺开。
 *
 * u 是沿某条边的位置，取值 -1（一端）到 1（另一端），0 是这条边的中点。
 */
const U_HORIZONTAL = [
  [-0.58, -0.3],
  [0.3, 0.58],
]; // 上下边：中间让给焦点卡片，两端让给 HUD
const U_VERTICAL = [[-0.56, 0.56]]; // 左右边：中间没有东西挡，可以用满
// 竖屏时上下边要并排塞两张卡片，得推得更开，否则两张会叠在一起
const U_HORIZONTAL_PORTRAIT = [
  [-0.66, -0.48],
  [0.48, 0.66],
];

/** 把 k 个位置平均撒进若干区间里（区间之间轮流分配）。 */
function spread(k, ranges) {
  const counts = new Array(ranges.length).fill(0);
  for (let i = 0; i < k; i++) counts[i % ranges.length]++;
  const out = [];
  counts.forEach((c, ri) => {
    const [lo, hi] = ranges[ri];
    for (let i = 0; i < c; i++) out.push(c === 1 ? (lo + hi) / 2 : lo + (hi - lo) * (i / (c - 1)));
  });
  return out;
}

/** 生成 n 个槽位坐标。起始边由 focusId 决定，所以同一支乐队每次进来方位一致。 */
function slotPoints(focusId, n, vw, vh) {
  const hw = vw / 2;
  const hh = vh / 2;
  // 窄屏左右放不下卡片——放下了也会盖住焦点卡片——所以只用上下两条边。
  const portrait = vw < 640 || vh / vw > 1.3;
  const sides = portrait ? ['s', 'n'] : ['e', 's', 'w', 'n'];
  const offset = hash32(focusId) % sides.length;

  const counts = new Array(sides.length).fill(0);
  for (let i = 0; i < n; i++) counts[(i + offset) % sides.length]++;

  const pts = [];
  sides.forEach((side, si) => {
    const k = counts[si];
    if (!k) return;
    const vertical = side === 'e' || side === 'w';
    // 0.94 而不是 1.0：卡片中心正压在边界上只露一半，名字会挤到读不出来。
    // 竖屏再往里收一点，给上下两条边的 HUD 让出位置。
    const reach = portrait ? 0.86 : 0.94;
    const ranges = vertical ? U_VERTICAL : portrait ? U_HORIZONTAL_PORTRAIT : U_HORIZONTAL;
    for (const u of spread(k, ranges)) {
      const x = (vertical ? (side === 'e' ? hw : -hw) : hw * u) * reach;
      const y = (vertical ? hh * u : side === 's' ? hh : -hh) * reach;
      pts.push({ x, y, angle: Math.atan2(y, x), radius: Math.hypot(x, y), side });
    }
  });
  return pts;
}

function angleDelta(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return Math.abs(d);
}

/**
 * 把邻居分配到槽位上。
 *
 * @param {string} focusId
 * @param {Array} edges          已按权重降序排好的展示边
 * @param {object} opts
 * @param {string} [opts.cameFrom]   来路乐队 id：必定入选，且占据「来的方向」的反向槽位
 * @param {number} [opts.backAngle]  来路乐队应该出现的期望角度（弧度）
 * @param {number} opts.vw
 * @param {number} opts.vh
 * @returns {Array} 每项 { edge, angle, x, y, radius, side }
 */
export function layoutNeighbors(focusId, edges, { cameFrom, backAngle, vw, vh }) {
  const limit = maxNeighbors(vw);

  // 取舍：权重降序截断，但来路乐队无论权重多低都必须留下（否则回不去）。
  let picked = edges.slice(0, limit);
  if (cameFrom && !picked.some((e) => e.to === cameFrom)) {
    const back = edges.find((e) => e.to === cameFrom);
    if (back) picked = [back, ...picked.slice(0, limit - 1)];
  }

  const points = slotPoints(focusId, picked.length, vw, vh);
  const taken = new Array(points.length).fill(false);
  const result = new Array(picked.length);

  // 先把来路乐队钉在离期望方向最近的槽位上，保住空间记忆。
  if (cameFrom && backAngle != null) {
    const idx = picked.findIndex((e) => e.to === cameFrom);
    if (idx >= 0) {
      let best = 0;
      let bestD = Infinity;
      points.forEach((p, i) => {
        const d = angleDelta(p.angle, backAngle);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      taken[best] = true;
      result[idx] = points[best];
    }
  }

  // 其余按 hash 排序后依次填空——顺序只取决于 id，因此结果可复现。
  const rest = picked
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => result[i] == null)
    .sort((a, b) => hash32(focusId + '::' + a.e.to) - hash32(focusId + '::' + b.e.to));

  let cursor = 0;
  for (const { i } of rest) {
    while (taken[cursor]) cursor++;
    taken[cursor] = true;
    result[i] = points[cursor];
  }

  return picked.map((edge, i) => ({ edge, ...result[i] }));
}
