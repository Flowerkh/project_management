import { browserPlatform } from './browser';
import type { Platform } from './types';

export type { FolderFile, LoadedFolder, Platform } from './types';

/** Electron이면 preload가 넣은 구현, 아니면 브라우저 구현 */
export function getPlatform(): Platform {
  if (typeof window !== 'undefined' && window.__PLATFORM__) return window.__PLATFORM__;
  return browserPlatform;
}
