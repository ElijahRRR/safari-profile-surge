// EasyQuick UI 的 Tailwind 3 预设：所有颜色、圆角、投影、渐变、模糊都读取 tokens.css 变量，
// 暗色选择器与设计系统 bundle 一致（[data-theme="dark"]）。不生成 preflight 与组件层——
// 那两部分由 easyquick.css（设计系统 bundle.css 原样）提供，这里只补工具类。

const SCALES = ['primary', 'accent', 'dark', 'gray', 'red', 'amber', 'emerald', 'green', 'yellow', 'blue', 'purple'];
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const colorVar = (name) => ({ opacityValue }) =>
  opacityValue === undefined || opacityValue === '1'
    ? `var(--${name})`
    : `color-mix(in srgb, var(--${name}) calc(${opacityValue} * 100%), transparent)`;

const colors = {
  transparent: 'transparent',
  current: 'currentColor',
  inherit: 'inherit',
  white: '#ffffff',
  black: '#000000',
};
for (const scale of SCALES) {
  colors[scale] = Object.fromEntries(STEPS.map((s) => [s, colorVar(`${scale}-${s}`)]));
}
for (const name of ['bg-page', 'bg-surface', 'bg-muted', 'bg-sidebar', 'border-default', 'border-subtle', 'border-control',
  'text-strong', 'text-default', 'text-body', 'text-muted', 'text-placeholder', 'brand', 'brand-text', 'brand-soft', 'on-brand',
  'success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft']) {
  colors[name] = colorVar(name);
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['variant', '&:where([data-theme="dark"], [data-theme="dark"] *)'],
  corePlugins: { preflight: false },
  theme: {
    colors,
    borderRadius: {
      none: '0px',
      DEFAULT: 'var(--radius)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      xl: 'var(--radius-xl)',
      '2xl': 'var(--radius-2xl)',
      '4xl': 'var(--radius-4xl)',
      full: 'var(--radius-full)',
    },
    fontFamily: {
      sans: 'var(--font-sans)',
      mono: 'var(--font-mono)',
    },
    extend: {
      boxShadow: {
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        glass: 'var(--shadow-glass)',
        'glass-sm': 'var(--shadow-glass-sm)',
        glow: 'var(--shadow-glow)',
        'glow-lg': 'var(--shadow-glow-lg)',
        'inner-glow': 'var(--shadow-inner-glow)',
        'btn-primary': 'var(--shadow-btn-primary)',
      },
      backgroundImage: {
        'gradient-primary': 'var(--gradient-primary)',
        'gradient-dark': 'var(--gradient-dark)',
        'gradient-glass': 'var(--gradient-glass)',
        'mesh-gradient': 'var(--gradient-mesh)',
      },
      backdropBlur: {
        xs: 'var(--blur-xs)',
        sm: 'var(--blur-sm)',
        xl: 'var(--blur-xl)',
      },
    },
  },
};
