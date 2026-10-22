// Run after npm ci: node scripts/measure-diff-parsing.mjs
import { parseDiffFromFile } from "@pierre/diffs";

for (const lines of [100, 250, 500, 1000, 2000, 5000]) {
  const original = Array.from({ length: lines }, (_, i) => `line ${i}: original value\n`).join("");
  const modified = original.replaceAll("original", "modified");
  const times = [];
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    parseDiffFromFile({ name: "file.txt", contents: original }, { name: "file.txt", contents: modified }, { context: 3 }, true);
    times.push(Math.round(performance.now() - start));
  }
  console.log(JSON.stringify({ lines, bytesPerSide: Buffer.byteLength(original), parseMs: times }));
}
