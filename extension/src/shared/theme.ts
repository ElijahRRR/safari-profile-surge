// 深色模式跟随系统：在 <html> 上设置 data-theme，与 EasyQuick 的暗色选择器一致。

export function applyTheme(doc: Document = document, win: Window = window): () => void {
  const media = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null;
  const apply = () => {
    doc.documentElement.dataset.theme = media?.matches ? 'dark' : 'light';
  };
  apply();
  if (!media) return () => {};
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
