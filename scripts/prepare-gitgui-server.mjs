import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const serverBinaryName = "gitgui-server";

const options = parseArguments(process.argv.slice(2));
const tauriTarget = nonEmpty(process.env.TAURI_ENV_TARGET_TRIPLE);
const targetTriple = options.target ?? tauriTarget ?? detectHostTriple();
const useCargoTarget = options.target !== null || (tauriTarget !== null && options.profile === "release");
const extension = isWindowsTarget(targetTriple) ? ".exe" : "";
const profileDirectory = options.profile;

if (!isValidTargetTriple(targetTriple)) {
  fail(`Invalid target triple: ${targetTriple}`);
}

const targetDirectory = resolveCargoTargetDirectory();
const cargoArguments = ["build", "--package", serverBinaryName, "--locked"];
if (options.profile === "release") {
  cargoArguments.push("--release");
}
if (useCargoTarget) {
  cargoArguments.push("--target", targetTriple);
}

const sourceDirectory = useCargoTarget
  ? join(targetDirectory, targetTriple, profileDirectory)
  : join(targetDirectory, profileDirectory);
const sourcePath = join(sourceDirectory, `${serverBinaryName}${extension}`);
const sidecarDirectory = join(projectRoot, "src-tauri", "binaries");
const sidecarPath = join(sidecarDirectory, `${serverBinaryName}-${targetTriple}${extension}`);

console.log(`[gitgui] sidecar target triple: ${targetTriple}`);
console.log(`[gitgui] sidecar profile: ${profileDirectory}`);
console.log(
  `[gitgui] cargo target mode: ${useCargoTarget ? `--target ${targetTriple}` : "default host target"}`,
);
console.log(`[gitgui] cargo output: ${sourcePath}`);
console.log(`[gitgui] Tauri sidecar path: ${sidecarPath}`);

if (options.dryRun) {
  console.log(`[gitgui] dry run: cargo ${cargoArguments.join(" ")}`);
  process.exit(0);
}

run("cargo", cargoArguments);

if (!existsSync(sourcePath)) {
  fail(`Cargo completed successfully but did not produce ${sourcePath}`);
}

mkdirSync(sidecarDirectory, { recursive: true });
copyFileSync(sourcePath, sidecarPath);

if (!isWindowsTarget(targetTriple)) {
  chmodSync(sidecarPath, 0o755);
}

console.log(`[gitgui] staged ${serverBinaryName} for Tauri: ${sidecarPath}`);

function parseArguments(argumentsList) {
  let profile = "debug";
  let target = null;
  let dryRun = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];

    if (argument === "--release") {
      if (profile === "release") {
        fail("--release was provided more than once");
      }
      profile = "release";
      continue;
    }

    if (argument === "--debug") {
      if (profile === "release") {
        fail("--debug and --release cannot be used together");
      }
      profile = "debug";
      continue;
    }

    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (argument === "--target") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("-")) {
        fail("--target requires a Rust target triple");
      }
      target = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--target=")) {
      const value = argument.slice("--target=".length);
      if (!value) {
        fail("--target requires a Rust target triple");
      }
      target = value;
      continue;
    }

    fail(`Unknown argument: ${argument}`);
  }

  return { dryRun, profile, target };
}

function detectHostTriple() {
  const modernResult = spawnSync("rustc", ["--print", "host-tuple"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (modernResult.status === 0) {
    const target = modernResult.stdout.trim();
    if (target) {
      return target;
    }
  }

  const legacyResult = spawnSync("rustc", ["-vV"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (legacyResult.status === 0) {
    const hostLine = legacyResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("host:"));
    const target = hostLine?.slice("host:".length).trim();
    if (target) {
      return target;
    }
  }

  const diagnostics = [modernResult.stderr, legacyResult.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  fail(`Could not determine the Rust host target triple.${diagnostics ? `\n${diagnostics}` : ""}`);
}

function resolveCargoTargetDirectory() {
  const metadataOutput = execFileSync(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--locked"],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );

  try {
    const metadata = JSON.parse(metadataOutput);
    if (typeof metadata.target_directory !== "string" || !metadata.target_directory) {
      fail("Cargo metadata did not provide a target directory");
    }
    return resolve(projectRoot, metadata.target_directory);
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`Cargo metadata returned invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

function run(command, argumentsList) {
  console.log(`[gitgui] running: ${command} ${argumentsList.join(" ")}`);
  const result = spawnSync(command, argumentsList, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    fail(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

function isWindowsTarget(target) {
  return /windows/i.test(target);
}

function isValidTargetTriple(target) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target);
}

function nonEmpty(value) {
  const normalized = value?.trim();
  return normalized || null;
}

function fail(message) {
  console.error(`[gitgui] sidecar preparation failed: ${message}`);
  process.exit(1);
}
