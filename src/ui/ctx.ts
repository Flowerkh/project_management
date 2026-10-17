import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Model, Target } from './model';

export interface Nav {
  model: Model;
  nav(t: Target): void;
  openFile(fileId: string, line?: number, query?: string): void;
  toast(msg: string): void;
}

export const NavCtx = createContext<Nav | null>(null);

export function useNav(): Nav {
  const v = useContext(NavCtx);
  if (!v) throw new Error('NavCtx 없음');
  return v;
}
