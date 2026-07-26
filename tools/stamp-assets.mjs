#!/usr/bin/env node
/**
 * 用内容哈希统一更新样式、入口脚本、地图模块与 graph.json 的缓存版本。
 * 计算哈希前会抹掉旧版本，因此内容不变时重复构建不会制造新版本。
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsFiles = (await readdir(path.join(root, 'js')))
  .filter((file) => file.endsWith('.js'))
  .sort()
  .map((file) => `js/${file}`);
const files = ['style.css', ...jsFiles, 'data/graph.json'];
const sources = await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')));
const normalized = sources.map((source) =>
  source
    .replace(/\?v=[a-zA-Z0-9._-]+/g, '?v=ASSET_VERSION')
    .replace(/const GRAPH_VERSION = '[^']+';/, "const GRAPH_VERSION = 'ASSET_VERSION';")
);
const version = createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 10);

const indexPath = path.join(root, 'index.html');
const index = (await readFile(indexPath, 'utf8'))
  .replace(/style\.css\?v=[a-zA-Z0-9._-]+/, `style.css?v=${version}`)
  .replace(/js\/main\.js\?v=[a-zA-Z0-9._-]+/, `js/main.js?v=${version}`);
const stampedModules = await Promise.all(
  jsFiles.map(async (file) => {
    const filePath = path.join(root, file);
    let source = await readFile(filePath, 'utf8');
    source = source.replace(
      /(from\s*['"]\.\/[^'"]+\.js)(?:\?v=[a-zA-Z0-9._-]+)?(['"])/g,
      `$1?v=${version}$2`
    );
    if (file === 'js/map.js') {
      source = source.replace(
        /const GRAPH_VERSION = '[^']+';/,
        `const GRAPH_VERSION = '${version}';`
      );
    }
    return [filePath, source];
  })
);

await Promise.all([
  writeFile(indexPath, index),
  ...stampedModules.map(([filePath, source]) => writeFile(filePath, source)),
]);
console.log(`✓ 静态资源版本 ${version}`);
