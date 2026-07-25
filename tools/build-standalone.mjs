#!/usr/bin/env node
/**
 * 把整个站点压成一个自包含的 HTML：样式内联、四个模块拼成一段脚本、
 * 全部乐队数据嵌进页面。产物没有任何外部请求，所以既能丢进禁止发请求的
 * 托管沙箱，也能直接双击打开。
 *
 *   node tools/build-data.mjs && node tools/build-standalone.mjs
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

// 依赖顺序：map 和 main 放在最后；全部模块会进入同一个函数作用域。
const MODULES = ['js/layout.js', 'js/data.js', 'js/render.js', 'js/map.js', 'js/main.js'];

/** 把 ES 模块拼成一段普通脚本：模块之间的 import/export 在同一作用域里是多余的。 */
function stripModuleSyntax(src) {
  return src
    .replace(/^import[\s\S]*?from\s*['"][^'"]*['"];?[ \t]*$/gm, '')
    .replace(/^export\s+/gm, '');
}

const [html, css] = await Promise.all([read('index.html'), read('style.css')]);

const title = html.match(/<title>([^<]*)<\/title>/)[1];
const description = html.match(/<meta name="description" content="([^"]*)"/)[1];
// 取 body 里的内容，去掉引外部脚本的那一行——脚本我们自己拼
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

const index = JSON.parse(await read('data/index.json'));
const graph = JSON.parse(await read('data/graph.json'));
const bands = {};
for (const file of (await readdir(path.join(root, 'data/bands'))).sort()) {
  if (!file.endsWith('.json')) continue;
  const doc = JSON.parse(await read(`data/bands/${file}`));
  bands[doc.id] = doc;
}

const sources = await Promise.all(MODULES.map(read));
const script = sources.map(stripModuleSyntax).join('\n');

// </script> 出现在 JSON 字符串里会提前结束脚本块；这里没有，但按规矩转义掉
const data = JSON.stringify({ index, graph, bands }).replace(/<\//g, '<\\/');

// charset 必须落在文件的前 1024 字节里，所以放在最前面：
// 单文件版没有 <head> 了，少了它中文会按 latin-1 解成乱码
const out = `<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<style>
${css}
</style>

${body}

<script>
globalThis.BAND_ATLAS_DATA = ${data};
(function () {
${script}
})();
</script>
`;

await mkdir(path.join(root, 'dist'), { recursive: true });
const dest = path.join(root, 'dist/band-atlas.html');
await writeFile(dest, out);

console.log(
  `✓ dist/band-atlas.html — ${index.bands.length} 支乐队，` +
    `${(Buffer.byteLength(out) / 1024).toFixed(0)} KB，无外部请求`
);
