import { cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));

async function resolveDependency(from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    try {
      await stat(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory) return null;
  }
}

// Materialize the production dependency graph instead of giving electron-builder
// npm workspace symlinks, which can silently omit the linked packages' files.
export async function stageDesktop(root, stage) {
  root = await realpath(root);
  const lock = await json(join(root, "package-lock.json"));
  const desktop = join(root, "apps/desktop");
  const manifest = await json(join(desktop, "package.json"));
  const { devDependencies, scripts, ...productionManifest } = manifest;
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, "package.json"), `${JSON.stringify(productionManifest, null, 2)}\n`);
  await cp(join(desktop, "dist"), join(stage, "dist"), { recursive: true });

  async function copyDependencies(source, destination, ancestors) {
    const pkg = await json(join(source, "package.json"));
    const optional = pkg.optionalDependencies ?? {};
    const peers = pkg.peerDependencies ?? {};
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(optional), ...Object.keys(peers)]);
    const children = [];
    const scope = new Map(ancestors);
    for (const name of names) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Invalid dependency name: ${name}`);
      const dependency = await resolveDependency(source, name);
      const isOptional = Object.hasOwn(optional, name) || pkg.peerDependenciesMeta?.[name]?.optional;
      if (!dependency) {
        if (isOptional) continue;
        throw new Error(`Missing production dependency ${name} from ${source}; run npm ci`);
      }
      if (ancestors.get(name)?.source === dependency) continue;
      const key = relative(root, dependency).split(sep).join("/");
      if (key.startsWith("../") || !lock.packages[key]) throw new Error(`Dependency is outside the npm lock: ${dependency}`);
      const dependencyManifest = await json(join(dependency, "package.json"));
      if (dependencyManifest.version !== lock.packages[key].version) throw new Error(`Installed dependency disagrees with npm lock: ${key}`);
      const child = { name, source: dependency, destination: join(destination, "node_modules", name) };
      children.push(child);
      scope.set(name, child);
    }
    for (const child of children) {
      const workspace = !relative(root, child.source).split(sep).includes("node_modules");
      await mkdir(dirname(child.destination), { recursive: true });
      await cp(child.source, child.destination, {
        recursive: true,
        dereference: true,
        filter: (file) => {
          const segments = relative(child.source, file).split(sep);
          if (segments.includes("node_modules") || segments.includes(".git")) return false;
          if (!workspace || file === child.source) return true;
          return ["package.json", "src", "dist"].includes(segments[0]) && !/\.(test|spec)\.[cm]?[jt]s$/.test(basename(file));
        },
      });
      if (workspace && child.name === "@gitgui/contracts") {
        // The workspace consumes TypeScript directly; packaged Node must load JavaScript.
        const stagedManifest = await json(join(child.destination, "package.json"));
        stagedManifest.exports = {
          ".": "./dist/protocol.js",
          "./desktop": "./dist/desktop.js",
          "./environment": "./dist/environment.js",
        };
        await writeFile(join(child.destination, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`);
      }
      await copyDependencies(child.source, child.destination, scope);
    }
  }
  await copyDependencies(desktop, resolve(stage), new Map());
  return productionManifest;
}
