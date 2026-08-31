#!/usr/bin/env node
// Hoogt de versie op in BEIDE manifests tegelijk en houdt ze gelijk — AMO
// weigert een versie die al is ingediend, en de twee builds horen hetzelfde
// versienummer te dragen.
//
//   node scripts/bump-version.mjs patch|minor|major|<x.y.z>   → schrijft + print
//   node scripts/bump-version.mjs --current                   → print alleen
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFESTS = ['firefox-extension/manifest.template.json', 'chrome-extension/manifest.template.json'];
const read = f => JSON.parse(readFileSync(f, 'utf8'));

const versions = MANIFESTS.map(f => read(f).version);
if (new Set(versions).size !== 1) {
  console.error(`✗ Manifests lopen uiteen: ${MANIFESTS.map((f, i) => `${f}=${versions[i]}`).join(', ')}`);
  process.exit(1);
}
const current = versions[0];

const arg = process.argv[2] || 'patch';
if (arg === '--current') { console.log(current); process.exit(0); }

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const parts = current.split('.').map(Number);
  while (parts.length < 3) parts.push(0);            // 1.3 → 1.3.0
  if (parts.some(Number.isNaN)) { console.error(`✗ Onleesbare versie: ${current}`); process.exit(1); }
  const [maj, min, pat] = parts;
  if (arg === 'major') next = `${maj + 1}.0.0`;
  else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
  else if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`;
  else { console.error(`✗ Onbekend argument: ${arg} (patch|minor|major|x.y.z)`); process.exit(1); }
}

// Gericht vervangen i.p.v. JSON.stringify, zodat opmaak en commentaarloze
// volgorde van de handmatig onderhouden manifests intact blijven.
for (const f of MANIFESTS) {
  const src = readFileSync(f, 'utf8');
  const out = src.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${next}"`);
  if (out === src) { console.error(`✗ Geen version-veld gevonden in ${f}`); process.exit(1); }
  writeFileSync(f, out);
}
console.log(next);
