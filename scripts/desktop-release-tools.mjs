import { createRequire } from "node:module";

// Use the installed packaging tools' own dependencies; no runtime dependency is added.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const updaterRequire = createRequire(require.resolve("electron-updater/package.json"));
export const asar = builderRequire("@electron/asar");
export const { blake2b } = builderRequire("@noble/hashes/blake2.js");
export const yaml = updaterRequire("js-yaml");
