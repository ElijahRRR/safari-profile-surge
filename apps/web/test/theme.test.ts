import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, createTheme } from '../src/store/theme';

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: dark && q.includes('dark'), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('theme', () => {
  it('follows prefers-color-scheme by default via data-theme on the root', () => {
    mockMatchMedia(true);
    const root = document.createElement('html');
    const theme = createTheme(root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(theme.state.preference).toBeNull();
  });

  it('persists the user choice and applies it on the next start', () => {
    mockMatchMedia(false);
    const root = document.createElement('html');
    const theme = createTheme(root);
    expect(root.getAttribute('data-theme')).toBe('light');
    theme.toggle();
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    const again = document.createElement('html');
    createTheme(again);
    expect(again.getAttribute('data-theme')).toBe('dark');
  });

  it('still toggles when storage throws', () => {
    mockMatchMedia(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const root = document.createElement('html');
    const theme = createTheme(root);
    expect(() => theme.toggle()).not.toThrow();
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});
