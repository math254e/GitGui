// Run after npm ci. Parsing runs in a Web Worker in the application; this
// script measures its CPU work, not browser responsiveness or network time.
import { processFile } from "@pierre/diffs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "gitgui-diff-measurement-"));
try {
  for (const lines of [500, 1000, 5000, 100_000]) {
    const original = Array.from({ length: lines }, (_, i) => `line ${i}: original value\n`).join("");
    const modified = original.replaceAll("original", "modified");
    writeFileSync(join(directory, "original"), original);
    writeFileSync(join(directory, "modified"), modified);
    const start = performance.now();
    const result = spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--text", "--diff-algorithm=myers", "--no-indent-heuristic", "--", "original", "modified"], {
      cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 1) throw new Error(result.stderr || "Git did not generate a diff");
    const gitMs = performance.now() - start;
    const parseStart = performance.now();
    const metadata = processFile(result.stdout, { oldFile: { name: "file.txt", contents: original }, newFile: { name: "file.txt", contents: modified }, throwOnError: true });
    if (metadata?.isPartial !== false) throw new Error("Incomplete parsed diff");
    console.log(JSON.stringify({ lines, bytesPerSide: Buffer.byteLength(original), gitMs: Math.round(gitMs), parseMs: Math.round(performance.now() - parseStart) }));
  }
} finally {
  if (!directory.startsWith(join(tmpdir(), "gitgui-diff-measurement-"))) throw new Error("Unexpected temporary directory");
  rmSync(directory, { recursive: true, force: true });
}
