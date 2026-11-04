#!/usr/bin/env node
// Read-only source pin verification. Planned ports are not vendored bodies.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = process.argv[2] ?? resolve(root, 'scripts/t3code-ssh-sources.json');
const checkout = process.argv[3] ?? process.env.T3CODE_PATH ?? 'D:/GitHub/PictureTagingApp.references/t3code';
const targetsRoot = process.argv[4] ?? root;
const safePath = path => typeof path === 'string' && /^[\w./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(manifest.commit) || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid manifest');
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (git('rev-parse', 'HEAD').toString().trim() !== manifest.commit) throw Error('Checkout commit mismatch');
  const seen = new Set();
  let targets = 0;
  for (const { path, sha256, adaptations = [] } of manifest.files) {
    if (!safePath(path) || seen.has(path) || !/^[a-f0-9]{64}$/.test(sha256)) throw Error(`Invalid source entry: ${path}`);
    seen.add(path);
    const pinned = git('show', `${manifest.commit}:${path}`);
    const actual = await readFile(resolve(checkout, path));
    if (digest(pinned) !== sha256) throw Error(`Pinned hash mismatch: ${path}`);
    if (!actual.equals(pinned)) throw Error(`Dirty upstream source: ${path}`);
    if (!Array.isArray(adaptations)) throw Error(`Invalid adaptation map: ${path}`);
    for (const adaptation of adaptations) {
      if (!safePath(adaptation.target) || adaptation.mode !== 'adapted' || !/^[a-f0-9]{64}$/.test(adaptation.sha256) ||
          !Array.isArray(adaptation.tests) || !adaptation.tests.length || !adaptation.tests.every(safePath)) throw Error(`Invalid adaptation entry: ${path}`);
      // Checkouts may use CRLF on Windows. Source pins remain exact committed
      // bytes; reviewed GitGui adaptations use explicitly normalized LF text.
      const body = (await readFile(resolve(targetsRoot, adaptation.target), 'utf8')).replaceAll('\r\n', '\n');
      if (digest(body) !== adaptation.sha256) throw Error(`Adaptation hash mismatch: ${adaptation.target}`);
      if (!body.includes(manifest.commit)) throw Error(`Missing adaptation provenance: ${adaptation.target}`);
      for (const test of adaptation.tests) await readFile(resolve(targetsRoot, test));
      targets++;
    }
  }
  console.log(`Verified ${seen.size} SSH source/test files and ${targets} reviewed adaptation mappings at ${manifest.commit}.`);
} catch (error) {
  console.error(`SSH source verification failed: ${error.message}`);
  process.exitCode = 1;
}
