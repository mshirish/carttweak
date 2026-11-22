/**
 * "Who's shopping?" profiles: a name only, stored in this browser
 * (localStorage, with an in-memory fallback when storage is blocked).
 */
export interface Profile {
  id: string;
  name: string;
  createdAt: string;
}

export const PROFILES_KEY = 'carttweak.profiles';
export const CURRENT_KEY = 'carttweak.currentProfile';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export class ProfileStore {
  private mem: Record<string, string> = {};
  private memOnly = false;
  warning: string | null = null;
  constructor(private kv: () => KV | null = () => (typeof window !== 'undefined' ? window.localStorage : null)) {}

  private get(k: string): string | null {
    if (!this.memOnly) {
      try {
        const s = this.kv();
        if (s) return s.getItem(k);
      } catch {
        this.fallback();
      }
    }
    return this.mem[k] ?? null;
  }
  private set(k: string, v: string | null) {
    if (!this.memOnly) {
      try {
        const s = this.kv();
        if (!s) throw new Error('no storage');
        if (v == null) s.removeItem(k);
        else s.setItem(k, v);
        return;
      } catch {
        this.fallback();
      }
    }
    if (v == null) delete this.mem[k];
    else this.mem[k] = v;
  }
  private fallback() {
    this.memOnly = true;
    this.warning = 'This browser is blocking storage, so profiles and hauls last only until you close this tab.';
  }

  list(): Profile[] {
    try {
      const v = JSON.parse(this.get(PROFILES_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string') : [];
    } catch {
      return [];
    }
  }
  current(): Profile | null {
    const id = this.get(CURRENT_KEY);
    return this.list().find((p) => p.id === id) ?? null;
  }
  /** Create (or pick the existing profile with the same name, case-insensitive) and sign in. */
  signIn(name: string): Profile {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!clean) throw new Error('name required');
    const all = this.list();
    let p = all.find((x) => x.name.toLowerCase() === clean.toLowerCase());
    if (!p) {
      p = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, createdAt: new Date().toISOString() };
      this.set(PROFILES_KEY, JSON.stringify([...all, p]));
    }
    this.set(CURRENT_KEY, p.id);
    return p;
  }
  pick(id: string): Profile | null {
    const p = this.list().find((x) => x.id === id) ?? null;
    if (p) this.set(CURRENT_KEY, p.id);
    return p;
  }
  signOut(): void {
    this.set(CURRENT_KEY, null);
  }
}

export const profileStore = new ProfileStore();
