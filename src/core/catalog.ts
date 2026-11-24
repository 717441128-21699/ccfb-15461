import { makeRng, randRange, randInt, pick, clamp } from './rng';
import type { StyleId, TrackKind, TrackSpec, VocalInterval } from './types';

export const ANALYZER_VERSION = 'aubio-lite-1';

interface StyleProfile {
  id: StyleId;
  label: string;
  kind: TrackKind;
  bpm: [number, number];
  introBars: [number, number];
  outroSec: [number, number];
  energy: [number, number];
}

export const STYLE_PROFILES: Record<StyleId, StyleProfile> = {
  pop: { id: 'pop', label: '城乡流行', kind: 'song', bpm: [104, 124], introBars: [4, 8], outroSec: [16, 26], energy: [0.72, 0.95] },
  folk: { id: 'folk', label: '田野民谣', kind: 'song', bpm: [80, 102], introBars: [4, 8], outroSec: [14, 24], energy: [0.42, 0.68] },
  rock: { id: 'rock', label: '乡镇摇滚', kind: 'song', bpm: [124, 146], introBars: [4, 8], outroSec: [18, 30], energy: [0.82, 1.0] },
  electronic: { id: 'electronic', label: '夜风电子', kind: 'song', bpm: [120, 132], introBars: [8, 16], outroSec: [18, 32], energy: [0.7, 0.96] },
  ballad: { id: 'ballad', label: '月夜抒情', kind: 'song', bpm: [66, 84], introBars: [4, 8], outroSec: [16, 28], energy: [0.38, 0.62] },
  'market-ad': { id: 'market-ad', label: '集市促销广告', kind: 'ad', bpm: [112, 124], introBars: [1, 2], outroSec: [1.2, 2.4], energy: [0.75, 0.95] },
  'agri-ad': { id: 'agri-ad', label: '农资服务广告', kind: 'ad', bpm: [92, 108], introBars: [1, 2], outroSec: [1.4, 2.6], energy: [0.55, 0.8] },
  'health-ad': { id: 'health-ad', label: '健康科普广告', kind: 'ad', bpm: [84, 98], introBars: [1, 2], outroSec: [1.5, 2.8], energy: [0.45, 0.7] },
  psa: { id: 'psa', label: '公益宣传', kind: 'ad', bpm: [88, 108], introBars: [1, 3], outroSec: [2, 3.5], energy: [0.5, 0.78] },
  'news-bed': { id: 'news-bed', label: '新闻片头/插播', kind: 'news', bpm: [116, 132], introBars: [1, 2], outroSec: [1.5, 3], energy: [0.7, 0.92] },
  jingle: { id: 'jingle', label: '台呼间乐', kind: 'jingle', bpm: [108, 126], introBars: [1, 2], outroSec: [2, 4], energy: [0.65, 0.9] },
  timesignal: { id: 'timesignal', label: '整点报时', kind: 'timesignal', bpm: [120, 120], introBars: [0, 0], outroSec: [0, 0], energy: [0.9, 1] },
};

const SONG_PREFIX = [
  '麦浪', '清河', '山路', '月光', '县城', '老街', '田间', '晚风', '渡口', '炊烟',
  '向阳', '丰收', '春雨', '冬雪', '桥头', '集市', '稻香', '果园', '青山', '白云',
];
const SONG_SUFFIX = [
  '小唱', '情歌', '谣', '之夜', '路上', '故乡', '早晨', '星空', '节拍', '故事',
  '回声', '暖阳', '灯火', '远行', '花开', '岁岁', '年年', '人间', '心愿', '远方',
];
const ARTISTS = ['县广播合唱团', '北坡乐队', '清河二人组', '麦穗乐团', '老周与收音机', '南山小风', '田野工作站', '渡口乐队'];

function beatGrid(firstBeat: number, bpm: number, duration: number): number[] {
  const period = 60 / bpm;
  const beats: number[] = [];
  for (let t = firstBeat; t < duration - 0.02; t += period) beats.push(Number(t.toFixed(6)));
  return beats;
}

function makeSongSpec(index: number): TrackSpec {
  const rng = makeRng(`song:${index}`);
  const styles: StyleId[] = ['pop', 'folk', 'rock', 'electronic', 'ballad'];
  const style = styles[index % styles.length];
  const profile = STYLE_PROFILES[style];
  const bpm = Math.round(randRange(rng, profile.bpm[0], profile.bpm[1]));
  const beatPeriod = 60 / bpm;
  const firstBeat = style === 'electronic' ? 0.04 : randRange(rng, 0.08, 0.18);
  const durationSec = Math.round(randRange(rng, 168, 246) * 10) / 10;
  const introBars = randInt(rng, profile.introBars[0], profile.introBars[1]);
  const vocalInSec = clamp(
    Math.round((firstBeat + introBars * 4 * beatPeriod + randRange(rng, -0.25, 0.4)) * 100) / 100,
    4,
    34,
  );
  const outroSec = randRange(rng, profile.outroSec[0], profile.outroSec[1]);
  const vocalEndSec = Math.round((durationSec - outroSec - randRange(rng, 0, 3)) * 100) / 100;
  const fadeStartSec = Math.round((durationSec - randRange(rng, 7.5, 11.5)) * 100) / 100;
  const fadeEndSec = durationSec;
  const vocal: VocalInterval[] = [{ startSec: vocalInSec, endSec: vocalEndSec, confidence: 1 }];
  const title = `${pick(rng, SONG_PREFIX)}${pick(rng, SONG_SUFFIX)}`;
  const artist = pick(rng, ARTISTS);

  return {
    id: `song-${String(index + 1).padStart(6, '0')}`,
    title: `${title} - ${artist}`,
    kind: 'song',
    style,
    styleLabel: profile.label,
    seed: hashIndex(index),
    durationSec,
    bpm,
    firstBeatSec: firstBeat,
    vocal,
    vocalInSec,
    vocalEndSec,
    fadeStartSec,
    fadeEndSec,
    nominalTakeOutSec: Math.min(durationSec - 0.15, Math.round((fadeStartSec + 3.0) * 100) / 100),
    energy: randRange(rng, profile.energy[0], profile.energy[1]),
    tags: [style, `${bpm}bpm`, '合成素材'],
    synthesized: true,
  };
}

function hashIndex(index: number): number {
  let x = (index + 1) * 2654435761;
  x ^= x >>> 16;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return x >>> 0;
}

interface MaterialOptions {
  id: string;
  title: string;
  style: StyleId;
  durationSec: number;
  bpm: number;
  voice?: [number, number] | null;
  seed?: number;
  kind?: TrackKind;
}

function makeMaterial(opts: MaterialOptions): TrackSpec {
  const profile = STYLE_PROFILES[opts.style];
  const rng = makeRng(opts.seed ?? opts.id);
  const firstBeat = 0.08;
  const fadeStartSec = Math.round((opts.durationSec - randRange(rng, 1.4, 2.8)) * 100) / 100;
  const voice = opts.voice === undefined ? [0.45, opts.durationSec - 2.2] as [number, number] : opts.voice;
  const vocal: VocalInterval[] = voice
    ? [{ startSec: voice[0], endSec: voice[1], confidence: 1 }]
    : [];
  return {
    id: opts.id,
    title: opts.title,
    kind: opts.kind ?? profile.kind,
    style: opts.style,
    styleLabel: profile.label,
    seed: hashString(opts.id),
    durationSec: opts.durationSec,
    bpm: opts.bpm,
    firstBeatSec: firstBeat,
    beats: beatGrid(firstBeat, opts.bpm, opts.durationSec),
    vocal,
    vocalInSec: vocal[0]?.startSec ?? null,
    vocalEndSec: vocal[0]?.endSec ?? null,
    fadeStartSec,
    fadeEndSec: opts.durationSec,
    nominalTakeOutSec: Math.min(opts.durationSec - 0.1, fadeStartSec + 1.2),
    energy: randRange(rng, profile.energy[0], profile.energy[1]),
    tags: [opts.style, '广告素材', '程序合成'],
    synthesized: true,
  };
}

function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createFeaturedMaterials(): TrackSpec[] {
  return [
    {
      id: 'time-signal',
      title: '北山广播电台整点报时',
      kind: 'timesignal',
      style: 'timesignal',
      styleLabel: STYLE_PROFILES.timesignal.label,
      seed: 1001,
      durationSec: 5.9,
      bpm: 120,
      firstBeatSec: 0,
      beats: [0, 0.8, 1.6, 2.4, 3.2, 4.0],
      vocal: [],
      vocalInSec: null,
      vocalEndSec: null,
      fadeStartSec: 5.5,
      fadeEndSec: 5.9,
      nominalTakeOutSec: 5.9,
      energy: 1,
      tags: ['整点', '六声报时', '第一声对标准时间'],
      synthesized: true,
    },
    makeMaterial({ id: 'ad-market-01', title: '城东大集年货节 30 秒', style: 'market-ad', durationSec: 30, bpm: 118 }),
    makeMaterial({ id: 'ad-agri-01', title: '县农资中心小麦追肥提醒', style: 'agri-ad', durationSec: 28, bpm: 96 }),
    makeMaterial({ id: 'ad-health-01', title: '冬季取暖通风公益提示', style: 'health-ad', durationSec: 32, bpm: 90 }),
    makeMaterial({ id: 'ad-psa-fire', title: '森林防火宣传 25 秒', style: 'psa', durationSec: 25, bpm: 96 }),
    makeMaterial({ id: 'jingle-station', title: '北山之声台呼 12 秒', style: 'jingle', durationSec: 12, bpm: 116, voice: [2.2, 7.5] }),
    makeMaterial({ id: 'news-breaking', title: '临时插播：县气象台寒潮快讯', style: 'news-bed', durationSec: 24, bpm: 124, seed: 20251125 }),
    makeMaterial({ id: 'filler-river', title: '垫乐：清水河晨曲 45 秒', style: 'folk', durationSec: 45, bpm: 88, voice: null, kind: 'filler' }),
    makeMaterial({ id: 'filler-night', title: '垫乐：值班室爵士小品 60 秒', style: 'pop', durationSec: 60, bpm: 108, voice: null, kind: 'filler' }),
    ...createExtraMaterials(),
  ];
}

export function createExtraMaterials(): TrackSpec[] {
  const fillers: TrackSpec[] = [8, 10, 12, 16, 20, 24, 30, 36, 45, 54, 60, 75, 90].map((durationSec, i) => {
    const styles: StyleId[] = ['folk', 'pop', 'electronic', 'ballad'];
    const style = styles[i % styles.length];
    return makeMaterial({
      id: `filler-bed-${String(i + 1).padStart(2, '0')}`,
      title: `可伸缩垫乐 ${durationSec} 秒 · ${STYLE_PROFILES[style].label}`,
      style,
      durationSec,
      bpm: [84, 96, 108, 122][i % 4],
      voice: null,
      kind: 'filler',
      seed: 3000 + i,
    });
  });

  const adStyles: StyleId[] = ['market-ad', 'agri-ad', 'health-ad', 'psa'];
  const ads = Array.from({ length: 16 }, (_, i) => {
    const style = adStyles[i % adStyles.length];
    const durationSec = 18 + ((i * 3) % 21);
    return makeMaterial({
      id: `ad-wheel-${String(i + 1).padStart(2, '0')}`,
      title: `${STYLE_PROFILES[style].label}素材 ${durationSec} 秒`,
      style,
      durationSec,
      bpm: [92, 100, 108, 118][i % 4],
      seed: 4000 + i,
    });
  });

  return [...fillers, ...ads];
}

export function createLibrarySpecs(count = 10000): TrackSpec[] {
  const songs = Array.from({ length: count }, (_, i) => makeSongSpec(i));
  return [...createFeaturedMaterials(), ...songs];
}

export function beatTimes(spec: Pick<TrackSpec, 'firstBeatSec' | 'bpm'>, durationSec: number): number[] {
  return beatGrid(spec.firstBeatSec, spec.bpm, durationSec);
}
