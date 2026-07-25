#!/usr/bin/env node
/**
 * 为“恩怨情仇 / 乐队史”人工审核准备原料。
 *
 * 只扫描现有乐队，按 ListenBrainz 热度优先取东亚与欧美各一批；从中文、
 * 日文、英文 Wikipedia 正文中寻找冲突、退出、诉讼、解散等关键词，
 * 输出上下文与原页链接。脚本不自动上线任何指控，所有结果都进 review。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, getJSON, sparql, stats } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/wikipedia-history'));

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);
const EAST_LIMIT = Number(args.east ?? 100);
const WEST_LIMIT = Number(args.western ?? 60);
const index = JSON.parse(await readFile(path.join(root, 'data/index.json'), 'utf8'));
const bandDocs = new Map();
for (const band of index.bands) {
  const doc = JSON.parse(await readFile(path.join(root, `data/bands/${band.id}.json`), 'utf8'));
  if (doc.mbid) bandDocs.set(doc.mbid, { ...band, mbid: doc.mbid });
}

const ranked = (region, limit) =>
  [...bandDocs.values()]
    .filter((band) => band.region === region)
    .sort((a, b) => b.listens - a.listens || b.degree - a.degree)
    .slice(0, limit);
const targets = [...ranked('east-asia', EAST_LIMIT), ...ranked('western', WEST_LIMIT)];
const targetByMbid = new Map(targets.map((band) => [band.mbid, band]));
const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size)
  );

const titles = new Map();
for (const [batchIndex, batch] of chunk(targets.map((band) => band.mbid), 80).entries()) {
  const values = batch.map((id) => `"${id}"`).join(' ');
  const rows = await sparql(`
    SELECT ?mbid ?zh ?ja ?en WHERE {
      VALUES ?mbid { ${values} }
      ?item wdt:P434 ?mbid .
      OPTIONAL { ?a schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> ; schema:name ?zh }
      OPTIONAL { ?b schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?ja }
      OPTIONAL { ?c schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?en }
    }`);
  for (const row of rows) {
    titles.set(row.mbid.value, {
      zh: row.zh?.value ?? null,
      ja: row.ja?.value ?? null,
      en: row.en?.value ?? null,
    });
  }
  console.log(`  Wikidata 标题 ${batchIndex + 1}/${Math.ceil(targets.length / 80)}：${titles.size}`);
}

const patterns = {
  zh: /争执|不和|决裂|矛盾|诉讼|起诉|解雇|开除|退团|离队|退出|解散|争议|被捕|毒品|吸毒|关系恶化|批评|抨击|冲突|斗殴|宿怨|闹翻|嫌隙/g,
  ja: /確執|不仲|対立|訴訟|脱退|解雇|逮捕|薬物|解散|批判|喧嘩|紛争|衝突|離脱/g,
  en: /\bfeud\b|falling out|\bconflict\b|\bdispute\b|\blawsuit\b|\bsued\b|\bfired\b|\bdismissed\b|quit the band|left the band|split up|\barrested\b|\bdrugs?\b|\brivalry\b|\bcriticized\b|\btension\b|\bfight\b/gi,
};

const results = [];
for (const lang of ['zh', 'ja', 'en']) {
  const wanted = new Map();
  for (const [mbid, labels] of titles) {
    if (!labels[lang]) continue;
    wanted.set(labels[lang], mbid);
  }
  let done = 0;
  for (const batch of chunk([...wanted.keys()], 5)) {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&prop=extracts&explaintext=1&exlimit=5&redirects=1` +
      (lang === 'zh' ? '&variant=zh-cn' : '') +
      `&titles=${encodeURIComponent(batch.join('|'))}`;
    const data = await getJSON(url);
    const redirects = new Map((data?.query?.redirects ?? []).map((item) => [item.to, item.from]));
    for (const page of Object.values(data?.query?.pages ?? {})) {
      if (!page.extract || page.missing !== undefined) continue;
      const requestedTitle = redirects.get(page.title) ?? page.title;
      const mbid = wanted.get(requestedTitle);
      const band = targetByMbid.get(mbid);
      if (!band) continue;
      const clean = page.extract.replace(/\s+/g, ' ').trim();
      const matches = [...clean.matchAll(patterns[lang])].slice(0, 8);
      if (!matches.length) continue;
      const contexts = matches.map((match) => {
        const start = Math.max(0, match.index - 180);
        const end = Math.min(clean.length, match.index + match[0].length + 260);
        return clean.slice(start, end).trim();
      });
      results.push({
        bandId: band.id,
        bandName: band.name,
        region: band.region,
        listens: band.listens,
        language: lang,
        title: page.title,
        source: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
        keywords: [...new Set(matches.map((match) => match[0]))],
        contexts,
        status: 'raw-unreviewed',
      });
    }
    done += batch.length;
    if (done % 25 === 0 || done === wanted.size) {
      console.log(`  ${lang}.wikipedia ${done}/${wanted.size}，原始候选 ${results.length}`);
    }
  }
}

results.sort(
  (a, b) =>
    (a.region === 'east-asia' ? -1 : 1) - (b.region === 'east-asia' ? -1 : 1) ||
    b.listens - a.listens ||
    a.language.localeCompare(b.language)
);
await mkdir(path.join(root, 'data/review'), { recursive: true });
await writeFile(
  path.join(root, 'data/review/wikipedia-history-raw.json'),
  JSON.stringify(
    {
      note: '关键词扫描原料，未核实、未翻译、未上线。必须回原页读上下文后人工审核。',
      generatedAt: new Date().toISOString(),
      scope: { eastAsia: EAST_LIMIT, western: WEST_LIMIT, bands: targets.length },
      candidates: results,
    },
    null,
    2
  ) + '\n'
);
const api = stats();
console.log(
  `✓ 扫描 ${targets.length} 支，得到 ${results.length} 个原始条目；缓存 ${api.hits} / 请求 ${api.misses}`
);
