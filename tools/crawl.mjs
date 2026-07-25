#!/usr/bin/env node
/**
 * 从种子乐队出发爬 MusicBrainz，产出 data/source/generated.json。
 *
 * 关键的一步是换个视角：MusicBrainz 存的是「乐队 ↔ 乐手」，而我们要的是
 * 「乐队 ↔ 乐队」。所以要穿过人来连——凡是共享过同一个乐手的两支乐队之间
 * 就落一条边，标签写那个人的名字。这正是「某个鼓手后来去了哪支乐队」。
 *
 *   node tools/crawl.mjs [--max-bands 400] [--depth 2] [--seed-limit 24]
 *
 * 全程限速一秒一次并落盘缓存，中断了重跑不会重复打接口。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, stats, mbArtist, mbSearchArtist, mbReleaseGroups } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/mb'));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const MAX_BANDS = arg('max-bands', 400);
const DEPTH = arg('depth', 2);
// 人工场景种子始终全部保留；额外种子按 seeds.json 的热门度顺序只拿前 N 支。
// 这样不会为了「扩数据」一口气把成千上万支边缘项目也拉进来。
const SEED_LIMIT = arg('seed-limit', 24);
const EAST_SEED_LIMIT = arg('east-seed-limit', 60);
/** 一个人挂太多乐队多半是录音室乐手，两两连边会炸出一堆噪音 */
const MAX_BANDS_PER_PERSON = 8;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------ 地名与类型 */

// MusicBrainz 的地名是英文，界面是中文。常见的几十个手工对一下，
// 对不上的就保留原文——比硬译或留空都好。
const AREA_ZH = {
  Tokyo: '东京', Osaka: '大阪', Fukuoka: '福冈', Kyoto: '京都', Nagoya: '名古屋',
  Sapporo: '札幌', Hokkaido: '北海道', Yokohama: '横滨', Kobe: '神户', Hiroshima: '广岛',
  Saitama: '埼玉', Chiba: '千叶', Nara: '奈良', Aomori: '青森', Sendai: '仙台',
  Okinawa: '冲绳', Kanagawa: '神奈川', Shizuoka: '静冈', Niigata: '新潟', Japan: '日本',
  London: '伦敦', Manchester: '曼彻斯特', Liverpool: '利物浦', Glasgow: '格拉斯哥',
  Bristol: '布里斯托', Leeds: '利兹', Sheffield: '谢菲尔德', Oxford: '牛津',
  Dublin: '都柏林', Ireland: '爱尔兰', England: '英格兰', Scotland: '苏格兰',
  'United Kingdom': '英国',
  'New York': '纽约', 'Los Angeles': '洛杉矶', Chicago: '芝加哥', Seattle: '西雅图',
  Boston: '波士顿', 'San Francisco': '旧金山', Detroit: '底特律', Austin: '奥斯汀',
  Portland: '波特兰', Minneapolis: '明尼阿波利斯', Athens: '雅典',
  'Washington, D.C.': '华盛顿特区', 'United States': '美国',
  Toronto: '多伦多', Montreal: '蒙特利尔', Canada: '加拿大',
  Melbourne: '墨尔本', Sydney: '悉尼', Australia: '澳大利亚',
  Berlin: '柏林', Germany: '德国', Stockholm: '斯德哥尔摩', Sweden: '瑞典',
  Seoul: '首尔', 'South Korea': '韩国', Taipei: '台北', Taiwan: '台湾',
  Beijing: '北京', Shanghai: '上海', China: '中国',
};

const zhArea = (name) => (name ? (AREA_ZH[name] ?? name) : null);
const COUNTRY_ZH = {
  JP: '日本', KR: '韩国', KP: '朝鲜', CN: '中国', TW: '台湾', HK: '香港', MO: '澳门', MN: '蒙古',
  US: '美国', GB: '英国', IE: '爱尔兰', CA: '加拿大', AU: '澳大利亚', NZ: '新西兰',
  DE: '德国', FR: '法国', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛',
  NL: '荷兰', BE: '比利时', ES: '西班牙', IT: '意大利', PT: '葡萄牙', AT: '奥地利', CH: '瑞士',
};

function countryCodeOf(artist) {
  // country 是 MusicBrainz 给艺人的 ISO 3166-1 代码；即使展示地点是某个区或城市，
  // 也能可靠地归到国家。area 本身为 Country 时则从它的 ISO 代码兜底。
  return artist.country ?? artist.area?.['iso-3166-1-codes']?.[0] ?? null;
}

// 值得留下的乐队↔乐队关系；其余（致敬、翻唱、同名等）一律丢弃
const DIRECT_REL = {
  collaboration: { type: 'guest', label: '合作' },
  'supporting musician': { type: 'guest', label: '伴奏・助演' },
  subgroup: { type: 'member', label: '副项目' },
  'artist rename': null,
  tribute: null,
};
// 人 ↔ 乐队的成员关系
const MEMBER_REL = new Set(['member of band', 'founder']);

// MusicBrainz 的 tag 是自由填的，国别、语言、听众自己的收藏标记全混在里面。
// 这些当流派展示会很怪：「Japanese」不是一种曲风。
const NOT_A_GENRE = new Set([
  'japanese', 'japan', 'japanese rock', 'american', 'usa', 'united states', 'british',
  'uk', 'united kingdom', 'english', 'canadian', 'australian', 'german', 'swedish',
  'korean', 'chinese', 'taiwanese', 'french', 'irish', 'scottish',
  'seen live', 'favourites', 'favorites', 'awesome', 'band', 'group', 'male vocalists',
  'female vocalists', 'live', 'rock and indie', 'under 2000 listeners', '00s', '90s', '80s', '70s',
]);

/* ------------------------------------------------------------------ 爬取 */

const bands = new Map(); // mbid -> MB artist doc（type = Group）
const people = new Map(); // mbid -> { name, memberships: [{bandId, begin, end, attrs}] }
const directEdges = []; // 乐队之间直接相连的关系

function relTargets(doc) {
  return (doc.relations ?? []).filter((r) => r['target-type'] === 'artist' && r.artist);
}

/** 记下一支乐队，返回是不是新的。 */
function noteBand(a) {
  if (a.type !== 'Group' || bands.has(a.id)) return false;
  bands.set(a.id, a);
  return true;
}

/** 取一支乐队的关系：拿到成员名单，顺带记下乐队之间的直接关系。 */
async function expandBand(mbid) {
  const doc = await mbArtist(mbid);
  if (!doc) return [];
  bands.set(mbid, { ...bands.get(mbid), ...doc });

  const newPeople = [];
  for (const rel of relTargets(doc)) {
    const other = rel.artist;

    if (MEMBER_REL.has(rel.type) && other.type === 'Person') {
      if (!people.has(other.id)) {
        people.set(other.id, { name: other.name, memberships: [] });
        newPeople.push(other.id);
      }
      people.get(other.id).memberships.push({
        bandId: mbid,
        begin: rel.begin ?? null,
        end: rel.end ?? null,
        attrs: rel.attributes ?? [],
      });
      continue;
    }

    const mapped = DIRECT_REL[rel.type];
    if (mapped && other.type === 'Group') {
      noteBand(other);
      directEdges.push({ from: mbid, to: other.id, ...mapped });
    }
  }
  return newPeople;
}

/** 取一个人的关系：他待过的所有乐队，就是网往外长的方向。 */
async function expandPerson(mbid) {
  const doc = await mbArtist(mbid);
  if (!doc) return [];

  const person = people.get(mbid);
  const found = [];
  for (const rel of relTargets(doc)) {
    if (!MEMBER_REL.has(rel.type)) continue;
    const band = rel.artist;
    if (band.type !== 'Group') continue;

    if (!person.memberships.some((m) => m.bandId === band.id)) {
      person.memberships.push({
        bandId: band.id,
        begin: rel.begin ?? null,
        end: rel.end ?? null,
        attrs: rel.attributes ?? [],
      });
    }
    if (noteBand(band)) found.push(band.id);
  }
  return found;
}

/* -------------------------------------------------------------- 种子 */

async function resolveSeeds() {
  const curated = JSON.parse(
    await readFile(path.join(root, 'data/source/scene-jrock.json'), 'utf8')
  );
  let extra = { seeds: [] };
  try {
    extra = JSON.parse(await readFile(path.join(root, 'data/source/seeds.json'), 'utf8'));
  } catch {
    /* 没有额外种子就只用人工整理的那批 */
  }
  let popular = { seeds: [] };
  try {
    popular = JSON.parse(await readFile(path.join(root, 'data/source/popular-seeds.json'), 'utf8'));
  } catch {
    /* 还没拉 ListenBrainz 榜单时，沿用手工热门序列 */
  }
  let eastAsia = { seeds: [] };
  try {
    eastAsia = JSON.parse(await readFile(path.join(root, 'data/source/east-asia-seeds.json'), 'utf8'));
  } catch {
    /* 没有东亚扩展种子时不影响原有数据管线 */
  }
  let rankedEastAsia = { seeds: [] };
  try {
    rankedEastAsia = JSON.parse(await readFile(path.join(root, 'data/source/east-asia-ranked-seeds.json'), 'utf8'));
  } catch {
    /* 热度榜尚未生成时使用人工候选顺序 */
  }

  // 有 ListenBrainz 榜单时，它是唯一的扩展顺序；手工列表只在没取到榜单时兜底。
  const extraSeeds = (popular.seeds?.length ? popular.seeds : extra.seeds ?? [])
    .slice(0, Math.max(0, SEED_LIMIT))
    .map((seed) => (typeof seed === 'string' ? { name: seed } : seed));
  const eastSeeds = (rankedEastAsia.seeds?.length ? rankedEastAsia.seeds : eastAsia.seeds ?? [])
    .slice(0, Math.max(0, EAST_SEED_LIMIT))
    .map((seed) => (typeof seed === 'string' ? { name: seed } : seed));
  // 旧的热门榜种子保住现有网络；新的扩展名额优先给东亚种子。
  const wanted = [...curated.bands.map((b) => ({ name: b.name, mbid: b.mbid })), ...eastSeeds, ...extraSeeds];

  const seeds = [];
  const missed = [];
  for (const w of wanted) {
    if (w.mbid) {
      // ListenBrainz 的榜单混有个人艺人。这里先确认是 Group，
      // 否则下面的成员关系爬取会把独唱艺人当成乐队根节点。
      const hit = bands.get(w.mbid) ?? (await mbArtist(w.mbid));
      if (hit?.type !== 'Group') continue;
      bands.set(hit.id, hit);
      if (!seeds.includes(hit.id)) seeds.push(hit.id);
      continue;
    }
    const res = await mbSearchArtist(w.name);
    const hit = (res?.artists ?? []).find((a) => a.type === 'Group') ?? res?.artists?.[0];
    if (!hit) {
      missed.push(w.name);
      continue;
    }
    if (!seeds.includes(hit.id)) {
      seeds.push(hit.id);
      bands.set(hit.id, hit);
    }
  }
  if (missed.length) log(`  ! 认领不到：${missed.join('、')}`);
  return seeds;
}

/* -------------------------------------------------------------- 主流程 */

log(`开始爬取：上限 ${MAX_BANDS} 支乐队，深度 ${DEPTH}`);
const seeds = await resolveSeeds();
log(`种子 ${seeds.length} 支（人工场景 + 东亚种子前 ${EAST_SEED_LIMIT} 支 + 热门榜前 ${SEED_LIMIT} 位）`);

let frontier = seeds;
for (let depth = 1; depth <= DEPTH; depth++) {
  log(`— 第 ${depth} 层：展开 ${frontier.length} 支乐队`);

  const freshPeople = [];
  for (const [i, id] of frontier.entries()) {
    freshPeople.push(...(await expandBand(id)));
    if (i % 25 === 24) log(`   乐队 ${i + 1}/${frontier.length}，累计 ${people.size} 人`);
  }

  if (depth === DEPTH) break; // 最后一层只补关系，不再往外扩

  log(`— 第 ${depth} 层：展开 ${freshPeople.length} 位乐手`);
  const nextBands = [];
  for (const [i, id] of freshPeople.entries()) {
    if (bands.size >= MAX_BANDS) break;
    nextBands.push(...(await expandPerson(id)));
    if (i % 50 === 49) log(`   乐手 ${i + 1}/${freshPeople.length}，累计 ${bands.size} 支乐队`);
  }
  frontier = nextBands.slice(0, Math.max(0, MAX_BANDS - seeds.length));
  log(`— 第 ${depth} 层结束：新增 ${frontier.length} 支乐队，总计 ${bands.size}`);
}

/* ---------------------------------------------------------- 组装成边 */

const edgeKey = (a, b, t) => [a, b].sort().join('|') + '|' + t;
const edges = new Map();

function addEdge(from, to, type, label, detail, year, weight) {
  if (from === to || !bands.has(from) || !bands.has(to)) return;
  const key = edgeKey(from, to, type);
  const existing = edges.get(key);
  if (existing) {
    // 同两支乐队、同一类关系有多个人时，把名字并起来而不是各画一条线。
    // 共享的人越多，这两支乐队的关系越实，排序时该更靠前。
    if (label && !existing.label.includes(label)) {
      existing.label += `・${label}`;
      existing.shared = (existing.shared ?? 1) + 1;
      existing.weight = Math.min(0.95, 0.62 + 0.11 * existing.shared);
      existing.detail = `${existing.shared} 位乐手在这两支乐队都待过：${existing.label}。`;
    }
    return;
  }
  edges.set(key, { from, to, type, label, detail, year, weight });
}

// 人牵出来的边：这是整张网的主干
for (const [, person] of people) {
  const inScope = person.memberships.filter((m) => bands.has(m.bandId));
  const uniq = [...new Map(inScope.map((m) => [m.bandId, m])).values()];
  if (uniq.length < 2 || uniq.length > MAX_BANDS_PER_PERSON) continue;

  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const [a, b] = [uniq[i], uniq[j]];
      const year = Number((b.begin ?? a.begin ?? '').slice(0, 4)) || null;
      addEdge(
        a.bandId,
        b.bandId,
        'member',
        person.name,
        `${person.name} 在这两支乐队都待过。`,
        year,
        0.62
      );
    }
  }
}

for (const e of directEdges) {
  addEdge(e.from, e.to, e.type, e.label, `MusicBrainz 记录的${e.label}关系。`, null, 0.55);
}

/* ------------------------------------------------------- 只留连得上的 */

const degree = new Map();
for (const e of edges.values()) {
  degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
  degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
}
const seedSet = new Set(seeds);
// 孤岛点进去就是死胡同；种子无论如何保留，它们后面还要跟人工数据合并
const keep = new Set(
  [...bands.keys()].filter((id) => seedSet.has(id) || (degree.get(id) ?? 0) >= 1)
);
log(`连得上的乐队 ${keep.size} / ${bands.size}`);

/* ------------------------------------------------------------ 补专辑 */

log(`取专辑（${keep.size} 支）…`);
const albumsOf = new Map();
let n = 0;
for (const id of keep) {
  const data = await mbReleaseGroups(id);
  const list = (data?.['release-groups'] ?? [])
    .filter((rg) => rg['primary-type'] === 'Album' && (rg['secondary-types'] ?? []).length === 0)
    .map((rg) => ({ title: rg.title, year: Number((rg['first-release-date'] ?? '').slice(0, 4)) || null }))
    .filter((a) => a.year)
    .sort((a, b) => a.year - b.year)
    .slice(0, 6);
  albumsOf.set(id, list);
  if (++n % 25 === 0) log(`   ${n}/${keep.size}`);
}

/* ------------------------------------------------------------ 产出 */

const slugSeen = new Map();
function slugify(name, id) {
  const base =
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'band';
  // 纯日文／中文名 slug 化之后可能撞车或为空，撞了就挂 mbid 前缀
  const count = slugSeen.get(base) ?? 0;
  slugSeen.set(base, count + 1);
  return count === 0 ? base : `${base}-${id.slice(0, 6)}`;
}

const idOf = new Map();
const outBands = [];
for (const id of keep) {
  const a = bands.get(id);
  const slug = slugify(a.name, id);
  idOf.set(id, slug);

  const begin = (a['life-span']?.begin ?? '').slice(0, 4);
  const end = (a['life-span']?.end ?? '').slice(0, 4);
  const years = begin ? (end ? `${begin}–${end}` : `${begin}–`) : null;

  // 门槛设成 2 的话四分之三的乐队一个流派都没有——冷门乐队本来就没几个人打标签
  const genres = (a.tags ?? [])
    .filter((t) => t.count >= 1 && !NOT_A_GENRE.has(t.name.toLowerCase()))
    .sort((x, y) => y.count - x.count)
    .slice(0, 3)
    .map((t) => t.name.replace(/\b\w/g, (c) => c.toUpperCase()));

  outBands.push({
    id: slug,
    mbid: id,
    name: a.name,
    area: zhArea(a['begin-area']?.name ?? a.area?.name),
    countryCode: countryCodeOf(a),
    country: COUNTRY_ZH[countryCodeOf(a)] ?? null,
    years,
    genres,
    albums: albumsOf.get(id) ?? [],
  });
}

const outEdges = [];
for (const e of edges.values()) {
  if (!idOf.has(e.from) || !idOf.has(e.to)) continue;
  outEdges.push({
    from: idOf.get(e.from),
    to: idOf.get(e.to),
    type: e.type,
    label: e.label,
    detail: e.detail,
    year: e.year,
    weight: e.weight,
  });
}

await mkdir(path.join(root, 'data/source'), { recursive: true });
await writeFile(
  path.join(root, 'data/source/generated.json'),
  JSON.stringify(
    {
      note: '由 tools/crawl.mjs 从 MusicBrainz 生成，请勿手改；人工修订写在 scene-jrock.json 里覆盖。',
      generatedAt: new Date().toISOString().slice(0, 10),
      bands: outBands,
      edges: outEdges,
    },
    null,
    2
  ) + '\n'
);

const c = stats();
log(`✓ ${outBands.length} 支乐队 / ${outEdges.length} 条边 → data/source/generated.json`);
log(`  接口调用 ${c.misses} 次，命中缓存 ${c.hits} 次`);
