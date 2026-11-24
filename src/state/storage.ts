// IndexedDB 元数据持久化 + 内存 PCM 缓存（PCM 不进 IDB，按需确定性重合成）
import type { Track } from '../shared/types';
import type { PCM } from '../audio/dsp';

const DB_NAME = 'broadcast-library';
const STORE = 'tracks';
const VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTracks(tracks: Track[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    for (const t of tracks) tx.objectStore(STORE).put(t);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function saveTrack(track: Track): Promise<void> {
  return saveTracks([track]);
}

export async function loadTracks(): Promise<Track[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as Track[]) ?? []);
    req.onerror = () => reject(req.error);
    db.close();
  });
}

export async function clearTracks(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** 内存 PCM 缓存：只保留 demo 素材，压测素材不落盘不缓存 */
const pcmCache = new Map<string, PCM>();

export function cachePCM(id: string, pcm: PCM): void {
  pcmCache.set(id, pcm);
}

export function getPCM(id: string): PCM | undefined {
  return pcmCache.get(id);
}

export function pcmCacheSize(): number {
  return pcmCache.size;
}
