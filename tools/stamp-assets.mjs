#!/usr/bin/env node
/**
 * 用内容哈希统一更新样式、入口脚本、地图模块与 graph.json 的缓存版本。
 * 计算哈希前会抹掉旧版本，因此内容不变时重复构建不会制造新版本。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['style.css', 'js/main.js', 'js/map.js', 'data/graph.json'];
const sources = await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')));
const normalized = sources.map((source) =>
  source
    .replace(/\?v=[a-zA-Z0-9._-]+/g, '?v=ASSET_VERSION')
    .replace(/const GRAPH_VERSION = '[^']+';/, "const GRAPH_VERSION = 'ASSET_VERSION';")
);
const version = createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 10);

const indexPath = path.join(root, 'index.html');
const mainPath = path.join(root, 'js/main.js');
const mapPath = path.join(root, 'js/map.js');
const index = (await readFile(indexPath, 'utf8'))
  .replace(/style\.css\?v=[a-zA-Z0-9._-]+/, `style.css?v=${version}`)
  .replace(/js\/main\.js\?v=[a-zA-Z0-9._-]+/, `js/main.js?v=${version}`);
const main = (await readFile(mainPath, 'utf8'))
  .replace(/\.\/map\.js\?v=[a-zA-Z0-9._-]+/, `./map.js?v=${version}`);
const map = (await readFile(mapPath, 'utf8'))
  .replace(/const GRAPH_VERSION = '[^']+';/, `const GRAPH_VERSION = '${version}';`);

await Promise.all([
  writeFile(indexPath, index),
  writeFile(mainPath, main),
  writeFile(mapPath, map),
]);
console.log(`✓ 静态资源版本 ${version}`);
