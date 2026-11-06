// 主题：<html data-theme="dark|light">。默认跟随系统 prefers-color-scheme；用户在侧边栏切换后的选择
// 存在 localStorage（读写都可能抛错，失败时只是不记住选择）。

import { reactive, type InjectionKey } from 'vue';

export const THEME_STORAGE_KEY = 'sfe.theme';
export type ThemePreference = 'light' | 'dark' | null;

function readPreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function writePreference(v: ThemePreference) {
  try {
    if (v) window.localStorage.setItem(THEME_STORAGE_KEY, v);
    else window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // 存储不可用：本次会话内仍然生效，只是下次不记得。
  }
}

function systemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function createTheme(root: HTMLElement = document.documentElement) {
  const state = reactive({ preference: readPreference(), dark: false });

  function apply() {
    state.dark = state.preference ? state.preference === 'dark' : systemPrefersDark();
    root.setAttribute('data-theme', state.dark ? 'dark' : 'light');
  }

  try {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', () => {
      if (!state.preference) apply();
    });
  } catch {
    // 旧环境没有 matchMedia 监听：只在启动时读取一次。
  }
  apply();

  return {
    state,
    toggle() {
      state.preference = state.dark ? 'light' : 'dark';
      writePreference(state.preference);
      apply();
    },
  };
}

export type Theme = ReturnType<typeof createTheme>;

export const THEME_KEY: InjectionKey<Theme> = Symbol('sfe-theme');
