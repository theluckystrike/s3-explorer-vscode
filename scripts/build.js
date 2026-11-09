'use strict';
// Bundles the extension host code with esbuild (no runtime dependencies besides Node and VS Code).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
(async () => {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  await esbuild.build({ bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root, platform: 'node', format: 'cjs', target: 'node18', entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', external: ['vscode'] });
  console.log(`built: extension ${(fs.statSync(path.join(root, 'dist/extension.js')).size / 1024).toFixed(0)} KB`);
})().catch((e) => { console.error(e); process.exit(1); });
