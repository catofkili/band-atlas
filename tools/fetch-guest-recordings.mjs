#!/usr/bin/env node
/**
 * 从 MusicBrainz 的录音层补“客串 / 合作”关系，只连接已经收录的乐队。
 *
 * 默认按 ListenBrainz 热度扫描东亚 120 支、欧美 40 支；每支录音很多时
 * 取前、中、后三段，避免只看到按字母排在最前面的作品。候选必须满足：
 *   1. 录音署名里同时出现另一支站内乐队；或
 *   2. artist-recording 关系明确带 guest / additional / solo 属性，
 *      且该演奏者是另一支站内乐队的成员。
 *
 * MusicBrainz 匿名 API 限速为每秒一次，公共请求器会限速、重试并逐页缓存。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { useCache, getJSON, mbArtist, stats } from './lib/mb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
useCache(path.join(root, '.cache/mb-recording-guests'));

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);
const EAST_LIMIT = Number(args.east ?? 120);
const WEST_LIMIT = Number(args.western ?? 40);
const PAGE_COUNT = Math.max(1, Math.min(3, Number(args.pages ?? 3)));
const PAGE_SIZE = 100;
const MB = 'https://musicbrainz.org/ws/2';

const index = JSON.parse(await readFile(path.join(root, 'data/index.json'), 'utf8'));
const source = JSON.parse(await readFile(path.join(root, 'data/source/generated.json'), 'utf8'));
const curated = JSON.parse(await readFile(path.join(root, 'data/source/scene-jrock.json'), 'utf8'));
const allSourceBands = [...source.bands, ...curated.bands].filter((band) => band.mbid);
const sourceByMbid = new Map(allSourceBands.map((band) => [band.mbid, band]));
const indexById = new Map(index.bands.map((band) => [band.id, band]));
const currentByMbid = new Map();
for (const [mbid, sourceBand] of sourceByMbid) {
  const finalBand =
    indexById.get(sourceBand.id) ??
    index.bands.find((candidate) => candidate.name === sourceBand.name);
  if (finalBand) currentByMbid.set(mbid, finalBand);
}

const hottest = (region, limit) =>
  [...currentByMbid.entries()]
    .filter(([, band]) => band.region === region)
    .sort((a, b) => b[1].listens - a[1].listens || b[1].degree - a[1].degree)
    .slice(0, limit);
const eastTargets = hottest('east-asia', EAST_LIMIT);
const westernTargets = hottest('western', WEST_LIMIT);
const targets = [...eastTargets, ...westernTargets];

const pageOffsets = (count) => {
  if (count <= PAGE_SIZE || PAGE_COUNT === 1) return [0];
  if (PAGE_COUNT === 2) return [0, Math.max(0, count - PAGE_SIZE)];
  return [
    0,
    Math.max(0, Math.floor((count - PAGE_SIZE) / 2 / PAGE_SIZE) * PAGE_SIZE),
    Math.max(0, count - PAGE_SIZE),
  ].filter((offset, index, values) => values.indexOf(offset) === index);
};
const guestAttribute = (relation) =>
  (relation.attributes ?? []).some((attribute) =>
    /^(guest|additional|solo)$/i.test(attribute)
  );
const relationCanBePerformance = (relation) =>
  relation['target-type'] === 'artist' &&
  relation.artist &&
  guestAttribute(relation) &&
  !['producer', 'mix', 'recording', 'mastering', 'engineer', 'writer', 'arranger'].includes(
    relation.type
  );

const evidenceByPair = new Map();
const guestPeople = new Map();
const pairKey = (a, b) => [a, b].sort().join('|');

function addEvidence(from, to, evidence) {
  if (!from || !to || from === to) return;
  const key = pairKey(from, to);
  const existing = evidenceByPair.get(key) ?? {
    from,
    to,
    performers: new Set(),
    recordings: new Map(),
  };
  if (evidence.performer) existing.performers.add(evidence.performer);
  existing.recordings.set(evidence.recordingId, {
    title: evidence.title,
    url: `https://musicbrainz.org/recording/${evidence.recordingId}`,
  });
  evidenceByPair.set(key, existing);
}

function inspectRecording(targetMbid, targetBand, recording) {
  for (const credit of recording['artist-credit'] ?? []) {
    const other = currentByMbid.get(credit.artist?.id);
    if (other && credit.artist.id !== targetMbid) {
      addEvidence(targetBand.id, other.id, {
        performer: credit.name ?? credit.artist.name,
        recordingId: recording.id,
        title: recording.title,
      });
    }
  }

  for (const relation of recording.relations ?? []) {
    if (!relationCanBePerformance(relation)) continue;
    const artist = relation.artist;
    const other = currentByMbid.get(artist.id);
    if (other && artist.id !== targetMbid) {
      addEvidence(targetBand.id, other.id, {
        performer: artist.name,
        recordingId: recording.id,
        title: recording.title,
      });
      continue;
    }
    if (artist.type === 'Person') {
      const person = guestPeople.get(artist.id) ?? {
        id: artist.id,
        name: artist.name,
        appearances: [],
      };
      person.appearances.push({
        targetMbid,
        targetId: targetBand.id,
        recordingId: recording.id,
        title: recording.title,
        explicitGuest: (relation.attributes ?? []).some((attribute) =>
          /^guest$/i.test(attribute)
        ),
      });
      guestPeople.set(artist.id, person);
    }
  }
}

console.log(
  `开始扫描 ${targets.length} 支现有乐队（东亚 ${eastTargets.length} / 欧美 ${westernTargets.length}）`
);
let completed = 0;
let failed = 0;
for (const [mbid, band] of targets) {
  const firstUrl =
    `${MB}/recording?artist=${mbid}&inc=artist-credits+artist-rels&fmt=json&limit=${PAGE_SIZE}&offset=0`;
  const first = await getJSON(firstUrl);
  if (!first) {
    failed += 1;
    completed += 1;
    continue;
  }
  for (const recording of first.recordings ?? []) inspectRecording(mbid, band, recording);
  const count = first['recording-count'] ?? first.count ?? first.recordings?.length ?? 0;
  for (const offset of pageOffsets(count).slice(1)) {
    const url =
      `${MB}/recording?artist=${mbid}&inc=artist-credits+artist-rels&fmt=json&limit=${PAGE_SIZE}&offset=${offset}`;
    const page = await getJSON(url);
    for (const recording of page?.recordings ?? []) inspectRecording(mbid, band, recording);
  }
  completed += 1;
  if (completed % 5 === 0 || completed === targets.length) {
    const api = stats();
    console.log(
      `  录音目录 ${completed}/${targets.length}，候选演奏者 ${guestPeople.size}，直接合作 ${evidenceByPair.size}（缓存 ${api.hits} / 请求 ${api.misses}）`
    );
  }
}

const people = [...guestPeople.values()];
console.log(`反查 ${people.length} 位明确标注的客串演奏者所属乐队`);
for (const [index, person] of people.entries()) {
  const doc = await mbArtist(person.id);
  const memberships = (doc?.relations ?? [])
    .filter((relation) => relation.type === 'member of band' && relation.artist)
    .map((relation) => currentByMbid.get(relation.artist.id))
    .filter(Boolean);
  const membershipIds = new Set(memberships.map((band) => band.id));
  for (const appearance of person.appearances) {
    // “solo / additional”也可能只是本团正式成员在自己歌曲里的独奏或和声。
    // 只有明确标成 guest，或该演奏者根本不是目标团成员时，才连到其余乐队。
    if (!appearance.explicitGuest && membershipIds.has(appearance.targetId)) continue;
    for (const memberBand of memberships) {
      if (memberBand.id === appearance.targetId) continue;
      addEvidence(appearance.targetId, memberBand.id, {
        performer: person.name,
        recordingId: appearance.recordingId,
        title: appearance.title,
      });
    }
  }
  if ((index + 1) % 10 === 0 || index + 1 === people.length) {
    console.log(`  演奏者 ${index + 1}/${people.length}，有效乐队对 ${evidenceByPair.size}`);
  }
}

const edges = [...evidenceByPair.values()]
  .map((evidence) => {
    const performers = [...evidence.performers].slice(0, 4);
    const recordings = [...evidence.recordings.values()].slice(0, 4);
    const performerText = performers.length ? performers.join('、') : '双方成员';
    const recordingText = recordings.map((recording) => `《${recording.title}》`).join('、');
    return {
      from: evidence.from,
      to: evidence.to,
      type: 'guest',
      weight: Math.min(0.86, 0.62 + recordings.length * 0.04),
      label: `客串：${performerText}`,
      detail: `MusicBrainz 录音资料显示，${performerText}参与了${recordingText}等录音。`,
      detailRev: `MusicBrainz 录音资料显示，${performerText}参与了${recordingText}等录音。`,
      sources: recordings.map((recording) => recording.url),
    };
  })
  .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));

await writeFile(
  path.join(root, 'data/source/guest-edges.json'),
  JSON.stringify(
    {
      note: 'MusicBrainz 录音署名与明确 guest/additional/solo 演奏关系，只连接站内已有乐队。',
      generatedAt: new Date().toISOString(),
      scope: {
        eastAsia: eastTargets.length,
        western: westernTargets.length,
        pagesPerArtist: PAGE_COUNT,
        artistsScanned: completed,
        failures: failed,
      },
      edges,
    },
    null,
    2
  ) + '\n'
);
const api = stats();
console.log(
  `✓ 新客串/合作 ${edges.length} 对，扫描失败 ${failed}，缓存命中 ${api.hits}，实际请求 ${api.misses}`
);
