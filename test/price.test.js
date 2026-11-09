'use strict';
// VER15 (2026-11-09): Zovo Pro is the "$19 one time" Sponsors tier. No product text may still say USD 15
// or promise Pro for "USD 10 or more" paid in total (the notemods tiers never unlock Pro).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('price text: USD 19 in pro.js, README and the Get Pro command; never USD 15', () => {
  for (const f of ['src/pro.js', 'README.md', 'package.json', 'CHANGELOG.md']) {
    assert.doesNotMatch(read(f), /USD 15|\$15 once|15 once/, f);
  }
  assert.match(read('src/pro.js'), /USD 19 once/);
  assert.match(read('README.md'), /USD 19 once/);
  assert.match(read('README.md'), /sponsorships\?tier_id=679878/);
  const pkg = JSON.parse(read('package.json'));
  const getPro = pkg.contributes.commands.find((c) => c.command === 's3Explorer.getPro');
  assert.match(getPro.title, /USD 19 once/);
});

test('unlock text names the Zovo tier or a monthly sponsorship, not "already sponsored USD 10"', () => {
  for (const f of ['src/pro.js', 'README.md']) {
    assert.doesNotMatch(read(f), /already sponsored USD 10/i, f);
    assert.match(read(f), /monthly with USD 10 or more/, f);
  }
});

// VER15: vsce turns "#1931" into a link to our own repo's issue 1931 (a 404 inside the rival links of
// "Why this one"). The package script must switch that off.
test('package script disables GitHub issue linking (README rival links stay intact)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.package, /--no-gitHubIssueLinking/);
  const md = read('README.md');
  const bare = md.match(/\[[^\]]*#\d+\]\(https:\/\/github\.com\/[^)]+\/issues\/\d+\)/g) || [];
  assert.ok(bare.length >= 5, 'rival issue links present');
});
