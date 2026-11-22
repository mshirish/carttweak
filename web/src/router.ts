// Minimal hash router: #/start, #/saved/<id>, ...
export type RouteName = 'store' | 'start' | 'receipt' | 'list' | 'check' | 'goals' | 'results' | 'saved' | 'trip' | 'about';
export interface Route {
  name: RouteName;
  id?: string;
}

const NAMES: RouteName[] = ['store', 'start', 'receipt', 'list', 'check', 'goals', 'results', 'saved', 'trip', 'about'];

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = (parts[0] ?? 'start') as RouteName;
  if (name === 'saved' && parts[1]) return { name: 'trip', id: decodeURIComponent(parts[1]) };
  return NAMES.includes(name) ? { name } : { name: 'start' };
}

export function hrefFor(r: Route): string {
  if (r.name === 'trip') return `#/saved/${encodeURIComponent(r.id ?? '')}`;
  return `#/${r.name}`;
}

export function go(r: Route): void {
  const h = hrefFor(r);
  if (window.location.hash !== h) window.location.hash = h;
  window.scrollTo?.(0, 0);
}
