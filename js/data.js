const cache = new Map();
const inflight = new Map();

export const REL = {
  member: { name: '成员流动', short: '成员' },
  guest: { name: '客串・合作', short: '合作' },
  influence: { name: '影响', short: '影响' },
  feud: { name: '恩怨', short: '恩怨' },
  scene: { name: '同乡・同世代', short: '同世代' },
};

export async function loadIndex() {
  const res = await fetch('data/index.json');
  if (!res.ok) throw new Error('索引加载失败');
  return res.json();
}

export function loadBand(id) {
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
  return cache.has(id);
}

/** 焦点渲染完之后趁空闲把邻居全部拉下来，点过去就没有等待。 */
export function prefetchNeighbors(band) {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(() => {
    for (const e of band.edges) {
      if (!cache.has(e.to)) loadBand(e.to).catch(() => {});
    }
  });
}
