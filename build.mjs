// Builds public/app.js (CodeMirror + vim + pdf.js) and copies the pdf.js worker.
// Only needed when the front-end source (src/) changes: `npm install && npm run build`.
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  outfile: 'public/app.js',
  legalComments: 'eof', // keep the licence notices of the bundled packages
  logLevel: 'info',
});

copyFileSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'public/pdf.worker.min.mjs');
console.log('copied pdf.worker.min.mjs');
