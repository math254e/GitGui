#!/usr/bin/env node
/**
 * Compare the vendored T3 Code client runtime with the upstream checkout.
 *
 * The vendored files carry the upstream implementation with GitGui's
 * divergences applied. When T3 Code publishes a new snapshot, this script
 * shows which vendored files moved and how far they are from upstream, so
 * the upstream change can be re-applied on top of the divergence list in
 * `docs/t3code-vendoring.md`.
 *
 * Usage:
 *   node scripts/vendor-t3code.mjs            # report the differences
 *   node scripts/vendor-t3code.mjs --write    # copy verbatim bodies, report the rest
 *   node scripts/vendor-t3code.mjs --record-adaptations # record reviewed adapted hashes
 *
 * The upstream checkout is read from `T3CODE_PATH`, then from the manifest's
 * `upstream.defaultCheckout`.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repositoryRoot, "scripts", "t3code-vendored.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const upstreamRoot = process.env["T3CODE_PATH"] ?? manifest.upstream.defaultCheckout;
const write = process.argv.includes("--write");
const recordAdaptations = process.argv.includes("--record-adaptations");
const hash = (source) => createHash("sha256").update(source).digest("hex");
const withoutHeader = (source) => source.replace(/^\/\*\*\n \* Vendored from T3 Code[\s\S]*?\*\/\n/, "");

if (!existsSync(upstreamRoot)) {
  console.error(`The T3 Code checkout was not found at ${upstreamRoot}.`);
  console.error("Set T3CODE_PATH to the checkout that holds the vendored snapshot.");
  process.exit(1);
}

const actualCommit = execFileSync("git", ["-C", upstreamRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (actualCommit !== manifest.upstream.commit) {
  console.error(`The T3 Code checkout is at ${actualCommit}; expected ${manifest.upstream.commit}.`);
  process.exit(1);
}

/**
 * A crude but useful summary of how far a vendored file moved from upstream:
 * how many lines the vendored file adds and how many it drops.
 */
const countDifferences = (upstream, vendored) => {
  const upstreamLines = new Set(upstream.split("\n").map((line) => line.trim()).filter(Boolean));
  const vendoredLines = new Set(vendored.split("\n").map((line) => line.trim()).filter(Boolean));
  let added = 0;
  let removed = 0;
  for (const line of vendoredLines) {
    if (!upstreamLines.has(line)) added += 1;
  }
  for (const line of upstreamLines) {
    if (!vendoredLines.has(line)) removed += 1;
  }
  return { added, removed };
};

const applyReplacements = (source, replacements) => {
  let result = source;
  for (const needle of replacements ?? []) {
    const rule = (manifest.replacements ?? []).find((candidate) => candidate.from === needle);
    if (rule === undefined) continue;
    result = result.split(rule.from).join(rule.to);
  }
  return result;
};

const results = [];
for (const entry of manifest.files) {
  const upstreamPath = join(upstreamRoot, entry.upstream);
  const targetPath = join(repositoryRoot, entry.target);
  if (!existsSync(upstreamPath)) {
    results.push({ ...entry, status: "missing-upstream" });
    continue;
  }
  if (!existsSync(targetPath)) {
    results.push({ ...entry, status: "missing-target" });
    continue;
  }
  const rawUpstream = await readFile(upstreamPath, "utf8");
  const pinnedUpstream = execFileSync("git", ["-C", upstreamRoot, "show", `${manifest.upstream.commit}:${entry.upstream}`], { encoding: "utf8" });
  if (rawUpstream !== pinnedUpstream) {
    results.push({ ...entry, status: "upstream-drifted" });
    continue;
  }
  const upstream = applyReplacements(
    rawUpstream,
    entry.replacements,
  );
  const vendored = await readFile(targetPath, "utf8");
  const header = vendored.slice(0, vendored.indexOf("*/") + 2);
  if (!header.startsWith("/**\n * Vendored from T3 Code") ||
      !header.includes(entry.upstream) || !header.includes(manifest.upstream.commit)) {
    results.push({ ...entry, status: "invalid-provenance" });
    continue;
  }
  if (entry.mode === "verbatim" && upstream !== withoutHeader(vendored)) {
    if (write) {
      await writeFile(
        targetPath,
        `${header}\n${upstream}`,
      );
      results.push({ ...entry, status: "rewritten", changed: countDifferences(upstream, vendored) });
      continue;
    }
    results.push({ ...entry, status: "drifted", changed: countDifferences(upstream, vendored) });
    continue;
  }
  if (entry.mode === "adapted") {
    if (recordAdaptations) {
      entry.upstreamSha256 = hash(rawUpstream);
      entry.targetSha256 = hash(vendored);
    } else if (entry.upstreamSha256 !== hash(rawUpstream) || entry.targetSha256 !== hash(vendored)) {
      results.push({ ...entry, status: "drifted", changed: countDifferences(upstream, vendored) });
      continue;
    }
  }
  results.push({
    ...entry,
    status: "ok",
    changed: countDifferences(upstream, vendored),
  });
}

if (recordAdaptations && results.every((result) => result.status === "ok")) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

let drifted = 0;
for (const result of results) {
  const marker = result.status === "ok" ? " " : "!";
  const changed = result.changed;
  const summary = changed === undefined
    ? result.status
    : `${result.status} +${changed.added}/-${changed.removed} lines`;
  console.log(`${marker} ${result.target} (${result.mode}) ${summary}`);
  if (result.status !== "ok") drifted += 1;
}

console.log("");
console.log(`Upstream: ${manifest.upstream.repository} @ ${manifest.upstream.commit} (${manifest.upstream.tag})`);
console.log(`Checkout: ${upstreamRoot}`);
console.log(
  drifted === 0
    ? "Every vendored file matches the pinned upstream and recorded adaptations."
    : `${drifted} file(s) need attention. See docs/t3code-vendoring.md.`,
);
process.exit(drifted === 0 ? 0 : 1);
