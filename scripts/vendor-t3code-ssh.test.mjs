import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('./vendor-t3code-ssh.mjs', import.meta.url));
test('SSH source pin rejects wrong commit, dirty content, hash drift and invalid entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitgui-ssh-pin-'));
  try {
    const repo = join(root, 'repo'); await mkdir(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    git('init');
    await writeFile(join(repo, 'source.ts'), 'source\n');
    git('add', 'source.ts'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    const manifest = { commit: git('rev-parse', 'HEAD'), files: [{ path: 'source.ts', sha256: createHash('sha256').update('source\n').digest('hex') }] };
    const file = join(root, 'manifest.json');
    const check = async () => { await writeFile(file, JSON.stringify(manifest)); return spawnSync(process.execPath, [tool, file, repo, root], { encoding: 'utf8' }); };
    assert.equal((await check()).status, 0);
    manifest.commit = '0'.repeat(40); assert.match((await check()).stderr, /commit mismatch/); manifest.commit = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'source.ts'), 'dirty\n'); assert.match((await check()).stderr, /Dirty upstream/);
    await writeFile(join(repo, 'source.ts'), 'source\n');
    manifest.files[0].sha256 = '0'.repeat(64); assert.match((await check()).stderr, /hash mismatch/);
    manifest.files[0].path = '../outside'; assert.match((await check()).stderr, /Invalid source entry/);
    manifest.files[0].path = 'source.ts';
    manifest.files[0].sha256 = createHash('sha256').update('source\n').digest('hex');
    const body = `// Adapted from ${manifest.commit}\nimplementation\n`;
    await writeFile(join(root, 'adapted.ts'), body.replaceAll('\n', '\r\n'));
    await writeFile(join(root, 'adapted.test.ts'), 'test fixture\n');
    manifest.files[0].adaptations = [{ target: 'adapted.ts', mode: 'adapted', sha256: createHash('sha256').update(body).digest('hex'), tests: ['adapted.test.ts'] }];
    assert.equal((await check()).status, 0);
    await writeFile(join(root, 'adapted.ts'), `${body}drift`);
    assert.match((await check()).stderr, /Adaptation hash mismatch/);
    await writeFile(join(root, 'adapted.ts'), body);
    manifest.files[0].adaptations[0].tests = ['../outside'];
    assert.match((await check()).stderr, /Invalid adaptation entry/);
    manifest.files[0].adaptations[0].tests = ['missing.test.ts'];
    assert.notEqual((await check()).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
