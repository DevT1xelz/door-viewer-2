// Сборка: bundle (dist/app.js) + одно-файловая версия (dist/door-standalone.html)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife',
  target: ['es2020'], loader: { '.hdr': 'binary' }, outfile: 'dist/app.js', legalComments: 'none', logLevel: 'info',
});
copyFileSync('index.template.html', 'dist/index.html');

const js = readFileSync('dist/app.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const html = readFileSync('index.template.html', 'utf8').replace('<script src="app.js"></script>', () => `<script>${js}</script>`);
writeFileSync('dist/door-standalone.html', html);
console.log('standalone:', (html.length / 1024).toFixed(0), 'kb');
