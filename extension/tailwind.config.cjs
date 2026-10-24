module.exports = {
  presets: [require('../packages/easyquick/tailwind.preset.cjs')],
  content: [__dirname + '/src/**/*.{vue,ts,html}', __dirname + '/../packages/easyquick/src/**/*.{vue,ts}'],
};
