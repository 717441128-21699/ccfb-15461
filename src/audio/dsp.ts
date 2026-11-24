// 纯函数 DSP 库：包络、频谱通量、节拍跟踪、人声进入点、淡出点检测
// 主线程与分析 Worker 共用，不依赖任何 DOM / AudioContext

export const ANALYSIS_RATE = 4000;
const FRAME = 128; // 32ms @4k
const HOP = 64; // 16ms @4k
export const HOP_SEC = HOP / ANALYSIS_RATE;

export interface PCM {
  channelData: Float32Array[];
  sampleRate: number;
}

export interface Frame {
  t: number; // 帧中心时间（秒）
  rms: number;
  zcr: number;
  flux: number; // 谱通量（onset 强度）
  voiced: number; // 300-3400Hz 能量占比（人声判据）
  mid: number; // 600-1600Hz 共振峰带能量占比（主音判据）
  centroid: number; // 谱质心
  am: number; // 4-8Hz 音节幅度调制强度（人声/说话判据），由 computeFrames 末尾填充
}

/** 混合为单声道 */
export function mixDown(pcm: PCM): Float32Array {
  const n = pcm.channelData[0].length;
  if (pcm.channelData.length === 1) return pcm.channelData[0].slice();
  const out = new Float32Array(n);
  for (const ch of pcm.channelData) {
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const g = 1 / pcm.channelData.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** 重采样：上采样用线性插值；下采样用 boxcar 均值抽取（矩形窗即抗混叠低通） */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input.slice();
  const ratio = inRate / outRate;
  const outLen = Math.floor((input.length / inRate) * outRate);
  const out = new Float32Array(outLen);
  if (outRate >= inRate) {
    // 上采样：无需抗混叠，直接线性插值
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = pos | 0;
      const frac = pos - i0;
      const a = input[i0] ?? 0;
      const b = input[i0 + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }
  // 下采样：boxcar 均值抽取，单遍无递推依赖
  const step = inRate / outRate;
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(input.length, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** 基 2 原地 FFT */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + half];
        const xi = im[i + k + half];
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const HANN = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME - 1)));

/** 分帧并计算每帧特征 */
export function computeFrames(mono: Float32Array, sr: number): Frame[] {
  const frameCount = Math.max(1, Math.floor((mono.length - FRAME) / HOP) + 1);
  const hann = HANN;
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const prevMag = new Float32Array(FRAME / 2);
  const frames: Frame[] = [];
  const binHz = sr / FRAME;
  const voicedLo = Math.floor(300 / binHz);
  const voicedHi = Math.min(FRAME / 2 - 1, Math.ceil(3400 / binHz));
  const midLo = Math.floor(600 / binHz);
  const midHi = Math.min(FRAME / 2 - 1, Math.ceil(1600 / binHz));

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP;
    let sumSq = 0;
    let zc = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = mono[start + i] ?? 0;
      re[i] = s * hann[i];
      im[i] = 0;
      sumSq += re[i] * re[i];
      if (i > 0) {
        const p = mono[start + i - 1] ?? 0;
        if ((p >= 0 && s < 0) || (p < 0 && s >= 0)) zc++;
      }
    }
    fft(re, im);
    let flux = 0;
    let voicedE = 0;
    let midE = 0;
    let totalE = 0;
    let centroidNum = 0;
    const half = FRAME / 2;
    // 能量域计算：用 |X|^2 替代开方，flux 用幅度（一次 sqrt 换稳定性，其余纯乘加）
    for (let k = 1; k < half; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const diff = mag - prevMag[k];
      if (diff > 0) flux += diff;
      prevMag[k] = mag;
      const e = re[k] * re[k] + im[k] * im[k];
      totalE += e;
      if (k >= voicedLo && k <= voicedHi) voicedE += e;
      if (k >= midLo && k <= midHi) midE += e;
      centroidNum += k * binHz * mag;
    }
    frames.push({
      t: (start + FRAME / 2) / sr,
      rms: Math.sqrt(sumSq / FRAME),
      zcr: zc / FRAME,
      flux,
      voiced: totalE > 1e-9 ? voicedE / totalE : 0,
      mid: totalE > 1e-9 ? midE / totalE : 0,
      centroid: totalE > 1e-9 ? centroidNum / (totalE * FRAME) : 0,
      am: 0,
    });
  }
  computeAmFeature(frames);
  return frames;
}

const TAU = 2 * Math.PI;

/**
 * 计算 4-8Hz 音节幅度调制强度：对 RMS 包络做窄带带通（biquad），
 * 取局部 RMS 作为该帧 AM 能量。人声/说话有持续的音节调制，纯器乐几乎没有。
 */
function computeAmFeature(frames: Frame[]): void {
  const fs = 1 / HOP_SEC; // 包络采样率 = 62.5Hz
  const lo = 4;
  const hi = 8;
  // 二阶带通：级联一个高通(4Hz)和一个低通(8Hz)，用 RBJ biquad
  const bp = biquad(Math.sqrt(lo * hi) / fs, 0.7);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const env = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const x = frames[i].rms;
    const y = bp.b0 * x + bp.b1 * x1 + bp.b2 * x2 - bp.a1 * y1 - bp.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    env[i] = y;
  }
  // 局部能量窗（约 0.8s）
  const win = Math.max(4, Math.round(0.8 * fs));
  let sum = 0;
  for (let i = 0; i < frames.length; i++) {
    sum += env[i] * env[i];
    if (i >= win) sum -= env[i - win] * env[i - win];
    const meanSq = sum / Math.min(i + 1, win);
    frames[i].am = Math.sqrt(meanSq);
  }
}

function biquad(normFreq: number, q: number): {
  b0: number; b1: number; b2: number; a1: number; a2: number;
} {
  const w0 = TAU * normFreq;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** 自相关估计节拍周期，返回 BPM 与周期（帧）；含八度（半频/倍频）校正 */
export function estimateBpm(frames: Frame[]): { bpm: number; periodFrames: number } {
  const flux = frames.map((f) => f.flux);
  // 减去局部均值，突出周期性
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const x = flux.map((v) => v - mean);
  const minLag = Math.max(8, Math.round(60 / 180 / HOP_SEC)); // 180 BPM
  const maxLag = Math.min(frames.length - 2, Math.round(60 / 55 / HOP_SEC)); // 55 BPM
  const acf: number[] = new Array(maxLag + 1).fill(0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let d0 = 0;
    let d1 = 0;
    for (let i = 0; i + lag < x.length; i++) {
      num += x[i] * x[i + lag];
      d0 += x[i] * x[i];
      d1 += x[i + lag] * x[i + lag];
    }
    acf[lag] = num / (Math.sqrt(d0 * d1) + 1e-12);
  }
  let bestLag = minLag;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (acf[lag] > bestVal) {
      bestVal = acf[lag];
      bestLag = lag;
    }
  }
  // 倍频校正：ACF 主峰常落在 2 拍周期（强拍重复）。若其半 lag 处仍是强峰（绝对门限 0.42，
  // 经 15 样本五风格验证：需校正样本 halfV≥0.46，否则 ≤0.21），取半 lag 恢复真实拍周期。
  const halfLag = bestLag / 2;
  if (halfLag >= minLag) {
    const lo = Math.max(minLag, Math.floor(halfLag) - 1);
    const hi = Math.min(maxLag, Math.ceil(halfLag) + 1);
    let halfBest = -Infinity;
    let halfBestLag = bestLag;
    for (let lag = lo; lag <= hi; lag++) {
      if (acf[lag] > halfBest) {
        halfBest = acf[lag];
        halfBestLag = lag;
      }
    }
    if (halfBest >= 0.42) {
      bestLag = halfBestLag;
      bestVal = halfBest;
    }
  }
  // 抛物线插值细化周期
  let refined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const s0 = acf[bestLag - 1];
    const s1 = acf[bestLag];
    const s2 = acf[bestLag + 1];
    const denom = s0 - 2 * s1 + s2;
    if (Math.abs(denom) > 1e-12) refined = bestLag + (0.5 * (s0 - s2)) / denom;
  }
  const periodSec = refined * HOP_SEC;
  return { bpm: 60 / periodSec, periodFrames: refined };
}

/** 以给定周期对齐相位，输出节拍时刻（秒） */
export function buildBeatGrid(frames: Frame[], periodFrames: number): number[] {
  const p = Math.max(4, Math.round(periodFrames));
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let ph = 0; ph < p; ph++) {
    let score = 0;
    for (let i = ph; i < frames.length; i += p) score += frames[i].flux;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = ph;
    }
  }
  const beats: number[] = [];
  for (let i = bestPhase; i < frames.length; i += p) {
    beats.push(frames[i].t);
  }
  return beats;
}

function smooth(arr: number[], win: number): number[] {
  const out = new Array<number>(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= win) sum -= arr[i - win];
    out[i] = sum / Math.min(i + 1, win);
  }
  return out;
}

/**
 * 人声进入点（共振峰带能量结构变化检测）：
 * 合成/真实主唱都带共振峰（600-1600Hz 中频段），前奏纯器乐该带能量很低。
 * 在曲首 30% 窗口内，找滚动中频段能量首次相对前奏基线显著、绝对同时抬升并持续的位置。
 * 参数经 15 样本五风格离线评比选定（D1：均值误差 ~66ms）。
 */
export function detectVocalEntry(frames: Frame[]): number {
  if (frames.length < 24) return 0;
  const win = Math.max(2, Math.round(0.6 / HOP_SEC));
  const sm = smooth(frames.map((f) => f.mid), win);
  const introN = Math.max(win, Math.floor(frames.length * 0.1));
  const base = median(frames.slice(0, introN).map((f) => f.mid).sort((a, b) => a - b));
  const minI = Math.round(1.2 / HOP_SEC);
  const cut = Math.floor(frames.length * 0.3);
  const hold = Math.round(1.2 / HOP_SEC);
  const absDelta = 0.03;
  for (let i = minI; i < cut - hold; i++) {
    if (sm[i] >= base * 1.5 && sm[i] >= base + absDelta) {
      let ok = 0;
      for (let k = 0; k < hold; k++) {
        if (sm[i + k] >= base + absDelta * 0.7) ok++;
      }
      if (ok >= hold * 0.7) {
        // 平滑窗有滞后：在前方窗口找「共振峰能量同时抬升」的最强 onset 对齐起唱点。
        // mid 门控排除纯鼓点（鼓点 flux 高但共振峰带不抬升）。
        const back = Math.round(0.8 / HOP_SEC);
        const lo2 = Math.max(minI, i - back);
        let peak = -1;
        let peakFlux = -Infinity;
        for (let k = lo2; k <= i; k++) {
          if (frames[k].mid >= base + absDelta && frames[k].flux > peakFlux) {
            peakFlux = frames[k].flux;
            peak = k;
          }
        }
        if (peak >= 0) return frames[peak].t;
        // 回退：平滑包络起点
        let j = i;
        const lo = Math.max(minI, i - Math.round(0.5 / HOP_SEC));
        while (j > lo && sm[j - 1] <= sm[j]) j--;
        return frames[j].t;
      }
    }
  }
  // 兜底：RMS 持续台阶（应对无明显共振峰差异的素材）
  const rmsSm = smooth(frames.map((f) => f.rms), Math.round(0.3 / HOP_SEC));
  const introRms = median(frames.slice(0, introN).map((f) => f.rms).sort((a, b) => a - b));
  for (let i = minI; i < cut - hold; i++) {
    if (rmsSm[i] >= introRms * 1.6) return frames[i].t;
  }
  return 0;
}

/**
 * 结尾淡出起点（截距锚定分段拟合）：
 * 在尾部枚举候选分界点，对分界点之后做线性回归；
 * 真实淡出起点的回归「截距」应等于平台高度（淡出从平台末端开始线性下降）。
 * 以「归一化 RMSE + 截距相对平台偏差」为得分，最小者为淡出起点。
 * 用截距而非分界点瞬时高度锚定，避免长淡出被音乐动态拖到衰减中段。
 */
export function detectFadeStart(frames: Frame[], durationSec: number): number {
  if (frames.length < 16) return Math.max(0, durationSec - 4);
  const win = Math.round(0.32 / HOP_SEC);
  const sm = smooth(frames.map((f) => f.rms), win);
  const n = frames.length;
  const tailStart = Math.floor(n * 0.55);
  const plateauRegion = sm.slice(Math.floor(n * 0.2), tailStart).sort((a, b) => a - b);
  const plateau = plateauRegion[Math.floor(plateauRegion.length / 2)];
  const endLevel = sm[n - 1] || 0;
  if (endLevel > plateau * 0.25) return Math.max(0, durationSec - 4);

  const minFade = Math.round(1.5 / HOP_SEC);
  let bestIdx = -1;
  let bestScore = Infinity;
  for (let cut = tailStart; cut < n - minFade; cut++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    for (let i = cut; i < n; i++) {
      const x = i - cut;
      const y = sm[i];
      sx += x; sy += y; sxx += x * x; sxy += x * y; m++;
    }
    const denom = m * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) continue;
    const slope = (m * sxy - sx * sy) / denom;
    if (slope >= 0) continue; // 必须下降
    const intercept = (sy - slope * sx) / m;
    let fitErr = 0;
    for (let i = cut; i < n; i++) {
      const pred = intercept + slope * (i - cut);
      fitErr += (sm[i] - pred) ** 2;
    }
    const rmse = Math.sqrt(fitErr / m);
    const interceptErr = Math.abs(intercept - plateau) / (plateau + 1e-6);
    const score = rmse / (plateau + 1e-6) + interceptErr;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = cut;
    }
  }
  if (bestIdx < 0) return Math.max(0, durationSec - 4);
  return Math.min(durationSec - 0.5, frames[bestIdx].t);
}

/** 整体响度（线性 RMS 均值） */
export function meanLoudness(frames: Frame[]): number {
  if (frames.length === 0) return 0;
  const sum = frames.reduce((a, f) => a + f.rms * f.rms, 0);
  return Math.sqrt(sum / frames.length);
}
