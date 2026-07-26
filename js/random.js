export const RANDOM_REGION_SHARES = {
  'east-asia': 0.55,
  elsewhere: 0.45,
};

const regionBucket = (band) => band.region === 'east-asia' ? 'east-asia' : 'elsewhere';

const popularityValue = (band) => {
  const local = Number(band.localPopularity);
  if (Number.isFinite(local) && local >= 0) return local;
  return Math.max(0, Number(band.listens) || 0);
};

/**
 * 原始收听量是严重长尾的，先转成同地区百分位，再套偏向中上段的钟形曲线。
 * 68% 附近最常出现；顶流仍比最冷门明显更常出现，但不会垄断随机入口。
 */
export function popularityPercentiles(bands) {
  const sorted = [...bands].sort(
    (a, b) => popularityValue(a) - popularityValue(b) || a.id.localeCompare(b.id)
  );
  const percentiles = new Map();
  const denominator = Math.max(1, sorted.length - 1);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    const value = popularityValue(sorted[start]);
    while (end < sorted.length && popularityValue(sorted[end]) === value) end += 1;
    const averageRank = (start + end - 1) / 2;
    for (let index = start; index < end; index += 1) {
      percentiles.set(sorted[index].id, averageRank / denominator);
    }
    start = end;
  }
  return percentiles;
}

export function bellPopularityWeight(percentile) {
  const p = Math.max(0, Math.min(1, percentile));
  const bell = Math.exp(-0.5 * ((p - 0.68) / 0.2) ** 2);
  return 0.08 + 0.75 * bell + 0.17 * p ** 2;
}

const weightedPick = (items, weightOf, random) => {
  const weights = items.map((item) => Math.max(0, weightOf(item)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return items[Math.floor(random() * items.length)];
  let ticket = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    ticket -= weights[index];
    if (ticket <= 0) return items[index];
  }
  return items.at(-1);
};

export function chooseRandomBand(
  bands,
  {
    recentIds = [],
    random = Math.random,
    regionShares = RANDOM_REGION_SHARES,
  } = {}
) {
  if (!bands.length) return null;

  const buckets = new Map();
  for (const band of bands) {
    const bucket = regionBucket(band);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(band);
  }

  // 先抽地区，确保展示份额不会被各区乐队数量或播放量改变。
  const availableRegions = [...buckets.keys()];
  const selectedRegion = weightedPick(
    availableRegions,
    (region) => regionShares[region] ?? 0,
    random
  );
  const pool = buckets.get(selectedRegion);
  const percentiles = popularityPercentiles(pool);
  const recent = new Set(recentIds);

  return weightedPick(
    pool,
    (band) => {
      const popularity = bellPopularityWeight(percentiles.get(band.id) ?? 0);
      const quality = Math.max(0, Math.min(1, (band.quality?.score ?? 25) / 100));
      const qualityBoost = 0.72 + 0.63 * quality ** 2;
      const connectedBoost = 0.9 + 0.2 * Math.min(band.degree ?? 0, 16) / 16;
      const repeatPenalty = recent.has(band.id) ? 0.15 : 1;
      return popularity * qualityBoost * connectedBoost * repeatPenalty;
    },
    random
  );
}
