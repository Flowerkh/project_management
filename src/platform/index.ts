import { browserPlatform } from './browser';
import { createElectronPlatform } from './electron';
import type { Platform } from './types';

export type { FolderFile, LoadedFolder, Platform } from './types';

let cached: Platform | null = null;

/** Electron이면 preload가 넣은 다리(__ELECTRON__)로 만든 구현, 아니면 브라우저 구현 */
export function getPlatform(): Platform {
  if (cached) return cached;
  if (typeof window !== 'undefined' && window.__PLATFORM__) cached = window.__PLATFORM__;
  else if (typeof window !== 'undefined' && window.__ELECTRON__) cached = createElectronPlatform(window.__ELECTRON__);
  else cached = browserPlatform;
  return cached;
}
