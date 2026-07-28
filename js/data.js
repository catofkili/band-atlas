const cache = new Map();
const inflight = new Map();

/**
 * 单文件版把全部数据直接嵌进页面（见 tools/build-standalone.mjs）。
 * 分享用的托管页面禁止页面自己发请求，只能走这条路；顺带也让打包出来的
 * 那一个 HTML 双击就能开。没有嵌入数据时照常按需 fetch。
 */
const EMBEDDED = globalThis.BAND_ATLAS_DATA ?? null;
const EMBEDDED_INDEX = globalThis.BAND_ATLAS_INDEX ?? null;

export const REL = {
  member: { name: '成员流动', short: '成员' },
  guest: { name: '客串・合作', short: '合作' },
  influence: { name: '影响', short: '影响' },
  feud: { name: '恩怨', short: '恩怨' },
  scene: { name: '场景・推荐', short: '推荐' },
};

export async function loadIndex() {
  if (EMBEDDED) return EMBEDDED.index;
  if (EMBEDDED_INDEX) return EMBEDDED_INDEX;
  const res = await fetch('data/index.json');
  if (!res.ok) throw new Error('索引加载失败');
  return res.json();
}

export function loadBand(id) {
  if (EMBEDDED) {
    const doc = EMBEDDED.bands[id];
    return doc ? Promise.resolve(doc) : Promise.reject(new Error(`找不到乐队 ${id}`));
  }
  if (cache.has(id)) return Promise.resolve(cache.get(id));
  if (inflight.has(id)) return inflight.get(id);

  const p = fetch(`data/bands/${encodeURIComponent(id)}.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`找不到乐队 ${id}`);
      return res.json();
    })
    .then((doc) => {
      cache.set(id, doc);
      inflight.delete(id);
      return doc;
    })
    .catch((err) => {
      inflight.delete(id);
      throw err;
    });

  inflight.set(id, p);
  return p;
}

export function isLoaded(id) {
  return EMBEDDED ? id in EMBEDDED.bands : cache.has(id);
}

/** 焦点渲染完之后趁空闲把邻居全部拉下来，点过去就没有等待。 */
export function prefetchNeighbors(band) {
  if (EMBEDDED) return; // 数据已经在页面里了
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(() => {
    for (const e of band.edges) {
      if (!cache.has(e.to)) loadBand(e.to).catch(() => {});
    }
  });
}
