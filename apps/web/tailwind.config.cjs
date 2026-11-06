module.exports = {
  presets: [require('../../packages/easyquick/tailwind.preset.cjs')],
  content: [__dirname + '/index.html', __dirname + '/src/**/*.{vue,ts}', __dirname + '/../../packages/easyquick/src/**/*.{vue,ts}'],
};
