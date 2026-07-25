#!/usr/bin/env node
/**
 * 给爬来的乐队补一段简介。
 *
 * MusicBrainz 只有硬事实，没有一句人话。这里走两步：
 * Wikidata 按 MusicBrainz id（P434）找到对应条目和它的维基百科链接，
 * 再去维基百科取首段。优先中文，没有中文条目就退到日文、英文——
 * 日本地下乐队的中文条目相当少，退而求其次也比留空强。
 *
 *   node tools/crawl.mjs && node tools/fetch-intros.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, getJSON, sparql, stats } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/mb'));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const generated = JSON.parse(await readFile(path.join(root, 'data/source/generated.json'), 'utf8'));
const modern = JSON.parse(await readFile(path.join(root, 'data/source/modern-japan.json'), 'utf8'));
const mbids = [...new Set([...generated.bands, ...modern.bands].map((b) => b.mbid).filter(Boolean))];
log(`要补简介的乐队与音乐人 ${mbids.length} 位`);

/* ------------------------------------------------- Wikidata：找到条目标题 */

const titles = new Map(); // mbid -> { zh, ja, en }

for (const [i, batch] of chunk(mbids, 120).entries()) {
  const values = batch.map((id) => `"${id}"`).join(' ');
  const rows = await sparql(`
    SELECT ?mbid ?zh ?ja ?en WHERE {
      VALUES ?mbid { ${values} }
      ?item wdt:P434 ?mbid .
      OPTIONAL { ?a schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> ; schema:name ?zh }
      OPTIONAL { ?b schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?ja }
      OPTIONAL { ?c schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?en }
    }`);
  for (const r of rows) {
    titles.set(r.mbid.value, {
      zh: r.zh?.value ?? null,
      ja: r.ja?.value ?? null,
      en: r.en?.value ?? null,
    });
  }
  log(`  Wikidata 批次 ${i + 1}：累计命中 ${titles.size}`);
}

/* --------------------------------------------- 维基百科：取首段并截短 */

/** 首段往往很长，卡片只放得下一两句。按句号切，攒到够长为止。 */
function condense(text, limit = 110) {
  const clean = text.replace(/\s+/g, ' ').replace(/（[^）]*）/g, '').trim();
  const parts = clean.split(/(?<=[。．！？.!?])/);
  let out = '';
  for (const p of parts) {
    if (out && out.length + p.length > limit) break;
    out += p;
    if (out.length >= limit * 0.6) break;
  }
  return (out || clean.slice(0, limit)).trim();
}

async function extractsFor(lang, wanted) {
  const found = new Map();
  for (const batch of chunk([...wanted.keys()], 20)) {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&prop=extracts&exintro=1&explaintext=1&exlimit=20&redirects=1` +
      (lang === 'zh' ? '&variant=zh-cn' : '') +
      `&titles=${encodeURIComponent(batch.join('|'))}`;
    const data = await getJSON(url);
    const pages = data?.query?.pages ?? {};
    // 跟着重定向走，返回的标题可能和请求的不一样，要对回去
    const back = new Map((data?.query?.redirects ?? []).map((r) => [r.to, r.from]));
    for (const p of Object.values(pages)) {
      if (!p.extract || p.missing !== undefined) continue;
      const title = back.get(p.title) ?? p.title;
      const mbid = wanted.get(title);
      if (mbid) found.set(mbid, condense(p.extract));
    }
  }
  return found;
}

const intros = {};
for (const lang of ['zh', 'ja', 'en']) {
  const wanted = new Map();
  for (const [mbid, t] of titles) {
    if (intros[mbid] || !t[lang]) continue;
    wanted.set(t[lang], mbid);
  }
  if (!wanted.size) continue;
  log(`${lang}.wikipedia：待取 ${wanted.size} 条`);
  const found = await extractsFor(lang, wanted);
  for (const [mbid, text] of found) intros[mbid] = { intro: text, lang };
  log(`  取到 ${found.size} 条`);
}

await writeFile(
  path.join(root, 'data/source/intros.json'),
  JSON.stringify(
    { note: '由 tools/fetch-intros.mjs 从维基百科生成，请勿手改。', intros },
    null,
    2
  ) + '\n'
);

const byLang = {};
for (const v of Object.values(intros)) byLang[v.lang] = (byLang[v.lang] ?? 0) + 1;
const c = stats();
log(`✓ ${Object.keys(intros).length} / ${mbids.length} 位有简介`, byLang);
log(`  接口调用 ${c.misses} 次，命中缓存 ${c.hits} 次`);
