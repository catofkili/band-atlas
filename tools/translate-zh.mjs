#!/usr/bin/env node
/**
 * 把现有数据中的外文说明翻成简体中文，并把结果永久缓存。
 *
 * 密钥只从环境变量读取，绝不写进产物：
 *   DEEPL_AUTH_KEY=... node tools/translate-zh.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'data/source/translations-zh.json');
const authKey = process.env.DEEPL_AUTH_KEY;
if (!authKey) throw new Error('缺少 DEEPL_AUTH_KEY 环境变量');

const endpoint = authKey.endsWith(':fx')
  ? 'https://api-free.deepl.com/v2/translate'
  : 'https://api.deepl.com/v2/translate';

const readJSON = async (relative, fallback = null) => {
  try {
    return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  } catch {
    return fallback;
  }
};

const generated = await readJSON('data/source/generated.json', { bands: [] });
const curated = await readJSON('data/source/scene-jrock.json', { bands: [] });
const { intros } = await readJSON('data/source/intros.json', { intros: {} });
const saved = await readJSON('data/source/translations-zh.json', {
  note: '由 tools/translate-zh.mjs 生成；源文本不变时可重复使用。',
  intros: {},
  areas: {},
  genres: {},
});
saved.intros ??= {};
saved.areas ??= {};
saved.genres ??= {};

async function persist() {
  saved.generatedAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(saved, null, 2) + '\n');
}

async function translate(texts, context) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${authKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Band-Atlas/1.0',
    },
    body: JSON.stringify({
      text: texts,
      target_lang: 'ZH-HANS',
      preserve_formatting: true,
      context,
    }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`DeepL ${response.status}: ${message.slice(0, 300)}`);
  }
  const data = await response.json();
  return data.translations.map((item) => item.text.trim());
}

async function runSection(name, entries, target, context, batchSize = 30) {
  const pending = entries.filter(([key, source]) => {
    const hit = target[key];
    return !hit || (typeof hit === 'object' && hit.source !== source);
  });
  console.log(`${name}：待翻译 ${pending.length} 条`);
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const translated = await translate(batch.map(([, source]) => source), context);
    batch.forEach(([key, source], index) => {
      target[key] = name === '简介'
        ? { source, text: translated[index] }
        : translated[index];
    });
    await persist();
    console.log(`  ${Math.min(i + batch.length, pending.length)} / ${pending.length}`);
  }
}

const foreignIntros = Object.entries(intros)
  .filter(([, value]) => value.lang !== 'zh' && value.intro)
  .map(([mbid, value]) => [mbid, value.intro]);

const allBands = [...generated.bands, ...curated.bands];
const areas = [...new Set(allBands.map((band) => band.area).filter(Boolean))]
  .map((area) => [area, area]);
const genres = [...new Set(allBands.flatMap((band) => band.genres || []).filter(Boolean))]
  .map((genre) => [genre, genre]);

await runSection(
  '简介',
  foreignIntros,
  saved.intros,
  '这是音乐关系网站中的乐队简介。保留乐队名、成员名、专辑名和歌曲名的原文拼写，其他内容翻译成自然、简洁的简体中文。',
  24
);
await runSection(
  '地区',
  areas,
  saved.areas,
  '这些是音乐人或乐队的国家、城市、行政区名称。翻译成中国大陆常用的简体中文地名。',
  40
);
await runSection(
  '流派',
  genres,
  saved.genres,
  '这些是音乐流派标签。翻译成中国大陆乐迷常用的简体中文流派名称。',
  40
);

await persist();
console.log(`✓ 中文翻译已保存：${path.relative(root, outputPath)}`);
