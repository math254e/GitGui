import { defineConfig } from "vitest/config";
import { transformWithEsbuild } from "vite";
import { compile, compileModule } from "svelte/compiler";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { conditions: ["browser"], alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) } },
  plugins: [{
    name: "workspace-state-tests",
    // Exercise the actual rune-based store without starting SvelteKit or a DOM.
    resolveId(id) { if (id.startsWith("$app/")) return `\0test:${id}`; },
    load(id) {
      if (id === "\0test:$app/navigation") return "export const goto = async () => {};";
      if (id === "\0test:$app/environment") return "export const browser = false;";
      if (id === "\0test:$app/state") return 'export const page = { route: { id: "/repo/[repositoryId]" }, params: {}, url: new URL("http://localhost/") };';
    },
    async transform(code, id) {
      if (id.endsWith(".svelte")) return compile(code, { filename: id, generate: "client", dev: false }).js;
      if (!id.endsWith(".svelte.ts")) return;
      const stripped = await transformWithEsbuild(code, id, { loader: "ts", target: "esnext" });
      return compileModule(stripped.code, { filename: id, generate: "client", dev: false }).js;
    },
  }],
  test: { include: ["src/**/*.test.ts"] },
});
