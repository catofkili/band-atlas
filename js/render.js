import { REL } from './data.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 连线层用一张固定大小的画布，原点摆在正中，省掉 viewBox 的负坐标换算。 */
export const CANVAS_HALF = 4000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function metaLine(band) {
  return [band.area, band.years].filter(Boolean).join(' · ');
}

/** 焦点卡片：这支乐队的全部内容都在这里。 */
export function buildFocusCard(band) {
  const card = el('article', 'card card--focus');
  card.dataset.id = band.id;

  const head = el('header', 'card__head');
  head.append(el('h1', 'card__name', band.name));
  head.append(el('p', 'card__meta', metaLine(band)));
  if (band.genres?.length) {
    const tags = el('ul', 'taglist');
    for (const g of band.genres) tags.append(el('li', 'tag', g));
    head.append(tags);
  }
  card.append(head);

  const body = el('div', 'card__body');

  if (band.intro) body.append(el('p', 'card__intro', band.intro));

  if (band.albums?.length) {
    const sec = section('代表作');
    const list = el('ol', 'albums');
    for (const a of band.albums) {
      const li = el('li', 'album');
      li.append(el('span', 'album__title', a.title));
      li.append(el('span', 'album__year', a.year ?? ''));
      list.append(li);
    }
    sec.append(list);
    body.append(sec);
  }

  if (band.tracks?.length) {
    const sec = section('代表曲');
    const list = el('ul', 'taglist taglist--tracks');
    for (const t of band.tracks) list.append(el('li', 'tag tag--track', t));
    sec.append(list);
    body.append(sec);
  }

  if (band.lore) {
    const sec = section('轶事');
    sec.append(el('p', 'lore', band.lore));
    if (band.loreSources?.length) {
      const sources = el('p', 'lore__sources', '来源：');
      band.loreSources.forEach((source, index) => {
        if (index) sources.append(document.createTextNode(' · '));
        const link = el('a', 'lore__source', source.label ?? '公开资料');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        sources.append(link);
      });
      sec.append(sources);
    }
    body.append(sec);
  }

  // 全部关系都列在这里：屏幕边缘放不下的、以及触屏上没有悬停可用的，都从这里走。
  // 枢纽乐队能有几十条，一次全塞进 DOM 既重又读不完，截断到最相关的一批。
  const REL_LIMIT = 30;
  const listed = band.edges.slice(0, REL_LIMIT);
  const relSec = section(`全部关系 ${band.edges.length}`);
  const rels = el('ul', 'rels');
  for (const e of listed) {
    const li = el('li');
    const btn = el('button', `rel-row rel-${e.type}`);
    btn.type = 'button';
    btn.dataset.id = e.to;
    const top = el('span', 'rel-row__top');
    top.append(el('span', 'rel-row__dot'));
    top.append(el('span', 'rel-row__name', e.toName));
    top.append(el('span', 'rel-row__label', e.label + (e.year ? ` · ${e.year}` : '')));
    btn.append(top);
    if (e.detail) btn.append(el('span', 'rel-row__detail', e.detail));
    li.append(btn);
    rels.append(li);
  }
  relSec.append(rels);
  if (band.edges.length > listed.length) {
    relSec.append(
      el('p', 'rels__more', `另有 ${band.edges.length - listed.length} 条关系未列出`)
    );
  }
  body.append(relSec);

  card.append(body);

  const foot = el('footer', 'card__foot');
  const counts = countByType(band.edges);
  const summary = el('p', 'card__counts');
  for (const [type, n] of counts) {
    const chip = el('span', `count count--${type}`);
    chip.append(el('span', 'count__dot'));
    chip.append(document.createTextNode(`${REL[type].name} ${n}`));
    summary.append(chip);
  }
  foot.append(summary);

  const link = el('a', 'card__link', 'MusicBrainz ↗');
  link.href = band.links?.musicbrainz ?? '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  foot.append(link);
  card.append(foot);

  return card;
}

function section(title) {
  const sec = el('section', 'card__section');
  sec.append(el('h2', 'card__label', title));
  return sec;
}

function countByType(edges) {
  const m = new Map();
  for (const e of edges) m.set(e.type, (m.get(e.type) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

/** 边缘卡片：只露一半，所以内容要贴在看得见的那半边。 */
export function buildPeekCard(slot) {
  const { edge, side } = slot;
  const card = el('button', `card card--peek card--peek-${side} rel-${edge.type}`);
  card.type = 'button';
  card.dataset.id = edge.to;
  card.setAttribute('aria-label', `前往 ${edge.toName}（${REL[edge.type].name}：${edge.label}）`);

  const inner = el('div', 'peek__inner');
  inner.append(el('span', 'peek__rel', REL[edge.type].short));
  inner.append(el('span', 'peek__name', edge.toName));
  inner.append(el('span', 'peek__meta', [edge.toArea, edge.toYears].filter(Boolean).join(' · ')));
  // 线上挂不下关系标签时（上下两边常常如此），由 placeChips 打开这一行顶上。
  inner.append(el('span', 'peek__label', edge.label + (edge.year ? ` · ${edge.year}` : '')));
  card.append(inner);
  return card;
}

/** 关系标签：贴在连线上，写清楚是谁、哪一年、什么事。 */
export function buildRelChip(slot) {
  const { edge } = slot;
  const chip = el('div', `relchip rel-${edge.type}`);
  const head = el('span', 'relchip__head');
  head.append(el('span', 'relchip__dot'));
  head.append(document.createTextNode(edge.label));
  if (edge.year) head.append(el('span', 'relchip__year', String(edge.year)));
  chip.append(head);
  if (edge.detail) chip.append(el('span', 'relchip__detail', edge.detail));
  return chip;
}

export function buildEdgeLayer() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('edges');
  svg.setAttribute('width', CANVAS_HALF * 2);
  svg.setAttribute('height', CANVAS_HALF * 2);
  svg.setAttribute('aria-hidden', 'true');
  svg.style.left = `${-CANVAS_HALF}px`;
  svg.style.top = `${-CANVAS_HALF}px`;
  return svg;
}

export function buildEdgeLine(slot) {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', `edge rel-${slot.edge.type}`);
  line.setAttribute('x1', CANVAS_HALF);
  line.setAttribute('y1', CANVAS_HALF);
  line.setAttribute('x2', CANVAS_HALF + slot.x);
  line.setAttribute('y2', CANVAS_HALF + slot.y);
  const len = Math.hypot(slot.x, slot.y);
  line.style.setProperty('--len', len.toFixed(1));
  return line;
}
