#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "2026.9.8";
const RELEASE_SRI =
  "sha512-G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q==";
const RELEASE_SHASUM = "7246c389c7134d9c15622082772912c7082f68af";
const TARBALL_URL = `https://registry.npmjs.org/openclaw/-/openclaw-${VERSION}.tgz`;
const BASELINE_SHA = "3b16db73c0b5209aad2ee7c3fb5ddfb12fb208f9";
const CANDIDATE_SHA = "a38ed66158bd270bd45607411aadb5862b299b8b";
const QA_RELATIVE = path.join("qa", "maccli-real-distribution-qa-20261005");
const TEST_RELATIVE = path.join(
  "apps",
  "macos",
  "Tests",
  "OpenClawIPCTests",
  "CLIInstallerRealDistributionProofTests.swift",
);
const SCRIPT_RELATIVE = path.join(QA_RELATIVE, "prepare.mjs");
const EXPECTED_NODE = "v24.19.0";
const EXPECTED_NPM = "11.17.0";
const MAX_DIAGNOSTIC_CHARS = 2400;
const MAX_DIAGNOSTIC_LINES = 12;

const here = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!mode || !["manifest", "install", "verify"].includes(mode)) {
    fail("usage: prepare.mjs manifest|install|verify --name value ...");
  }
  const result = { mode };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith("--") || index + 1 >= rest.length) {
      fail(`invalid argument near ${flag}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(result, key)) fail(`duplicate argument --${key}`);
    result[key] = rest[++index];
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) fail(`missing --${name}`);
  return value;
}

function absolute(value, label) {
  if (!path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isStrictlyWithin(parent, child) {
  return path.resolve(parent) !== path.resolve(child) && isWithin(parent, child);
}

function timestamp() {
  return new Date().toISOString();
}

async function hashFile(file, algorithm = "sha256") {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function integrityFromHex(hex) {
  return `sha512-${Buffer.from(hex, "hex").toString("base64")}`;
}

async function readJSON(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJSONExclusive(file, value) {
  const handle = await import("node:fs/promises").then(({ open }) => open(file, "wx", 0o600));
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function filteredEnvironment() {
  const names = [
    "PATH",
    "HOME",
    "CFFIXED_USER_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "DEVELOPER_DIR",
    "SDKROOT",
    "TOOLCHAINS",
    "CI",
    "GITHUB_ACTIONS",
    "RUNNER_OS",
    "RUNNER_TEMP",
    "OPENCLAW_PROFILE",
  ];
  return Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
}

function run(command, args, { cwd, env = filteredEnvironment() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let outputExceeded = false;
    let forceKillTimer;
    const maxBytes = 8 * 1024 * 1024;
    const collect = (target, chunk) => {
      if (outputExceeded) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        outputExceeded = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        forceKillTimer.unref?.();
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", (chunk) => {
      collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      collect(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (outputExceeded) {
        reject(new Error("subprocess output exceeded the bounded capture limit; child exited before cleanup continued"));
        return;
      }
      resolve({
        code: code ?? 128,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function diagnosticTail(output) {
  const clean = String(output ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /((?:_authToken|_password|password|access[_-]?token|token)\s*[:=]\s*)[\"']?[^\s,\"'}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:token|access_token|auth|password)=)[^&\s]+/gi, "$1[REDACTED]");
  return clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .slice(-MAX_DIAGNOSTIC_LINES).join("\n").slice(-MAX_DIAGNOSTIC_CHARS);
}

function commandReceipt(command, result) {
  const receipt = { command, exitCode: result.code, signal: result.signal };
  if (result.code !== 0) {
    const stdoutTail = diagnosticTail(result.stdout);
    const stderrTail = diagnosticTail(result.stderr);
    if (stdoutTail) receipt.stdoutTail = stdoutTail;
    if (stderrTail) receipt.stderrTail = stderrTail;
  }
  return receipt;
}

function commandFailure(command, result) {
  const details = commandReceipt(command, result);
  const signal = details.signal ? ` (signal ${details.signal})` : "";
  const excerpts = [
    details.stderrTail && `stderr tail:\n${details.stderrTail}`,
    details.stdoutTail && `stdout tail:\n${details.stdoutTail}`,
  ].filter(Boolean);
  return `${command} failed with exit ${details.exitCode}${signal}${excerpts.length ? `\n${excerpts.join("\n")}` : " (no captured stdout or stderr)"}`;
}

async function requireCommandVersion(command, expected, label) {
  const result = await run(command, ["--version"]);
  if (result.code !== 0) fail(`${label} --version failed with exit ${result.code}`);
  const value = result.stdout.trim();
  if (value !== expected) fail(`${label} version mismatch: expected ${expected}, received ${value}`);
  return value;
}

async function findExecutable(name) {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      const file = await realpath(candidate);
      const info = await stat(file);
      if (info.isFile()) return file;
    } catch {}
  }
  fail(`could not find executable ${name} on the configured PATH`);
}

async function gitHead(repoRoot) {
  const result = await run("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  if (result.code !== 0) fail("could not read the product checkout revision");
  return result.stdout.trim();
}

function artifactPairs(repoRoot, sidecarRoot) {
  return [
    {
      name: "prepare.mjs",
      source: path.join(sidecarRoot, "prepare.mjs"),
      staged: path.join(repoRoot, QA_RELATIVE, "prepare.mjs"),
    },
    {
      name: "README.md",
      source: path.join(sidecarRoot, "README.md"),
      staged: path.join(repoRoot, QA_RELATIVE, "README.md"),
    },
    {
      name: "CLIInstallerRealDistributionProofTests.swift",
      source: path.join(sidecarRoot, "CLIInstallerRealDistributionProofTests.swift"),
      staged: path.join(repoRoot, TEST_RELATIVE),
    },
  ];
}

async function compareStagedArtifacts(repoRoot, sidecarRoot) {
  const hashes = {};
  for (const pair of artifactPairs(repoRoot, sidecarRoot)) {
    const [sourceInfo, stagedInfo] = await Promise.all([lstat(pair.source), lstat(pair.staged)]);
    if (!sourceInfo.isFile() || !stagedInfo.isFile()) fail(`expected regular source and staged files for ${pair.name}`);
    const [sourceHash, stagedHash] = await Promise.all([hashFile(pair.source), hashFile(pair.staged)]);
    if (sourceHash !== stagedHash) fail(`staged product artifact differs from sidecar: ${pair.name}`);
    hashes[pair.name] = sourceHash;
  }
  return hashes;
}

async function npmMetadata(npm, userConfig, cache, cwd, commandReceipts) {
  const result = await run(npm, [
    "view",
    `openclaw@${VERSION}`,
    "version",
    "dist",
    "engines",
    "--json",
    `--registry=https://registry.npmjs.org/`,
    `--userconfig=${userConfig}`,
    `--cache=${cache}`,
    "--audit=false",
    "--fund=false",
  ], { cwd });
  commandReceipts.push(commandReceipt("npm view", result));
  if (result.code !== 0) fail(commandFailure("npm view", result));
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    fail("npm release metadata response was not valid JSON");
  }
  if (metadata?.version !== VERSION) fail("npm returned an unexpected release version");
  if (metadata?.dist?.integrity !== RELEASE_SRI) fail("official npm release integrity did not match the pinned SRI");
  if (metadata?.dist?.tarball !== TARBALL_URL) fail("official npm release tarball URL did not match the pinned URL");
  if (metadata?.dist?.shasum !== RELEASE_SHASUM) fail("official npm release SHA-1 did not match the preflight pin");
  return {
    version: metadata.version,
    integrity: metadata.dist.integrity,
    tarball: metadata.dist.tarball,
    shasum: metadata.dist.shasum,
    engines: metadata.engines ?? null,
  };
}

async function createManifest(args) {
  if (process.platform !== "darwin") fail("manifest preparation is supported only on the disposable macOS runner");
  const repoRoot = absolute(required(args, "repo-root"), "--repo-root");
  const receiptDir = absolute(required(args, "receipt-dir"), "--receipt-dir");
  const sidecarRoot = absolute(required(args, "sidecar-root"), "--sidecar-root");
  const productSha = required(args, "product-sha");
  if (![BASELINE_SHA, CANDIDATE_SHA].includes(productSha)) fail("product SHA is not the authorized baseline or candidate revision");
  if (await gitHead(repoRoot) !== productSha) fail("product checkout HEAD does not match --product-sha");
  if (isWithin(repoRoot, receiptDir)) fail("receipt directory must be outside the product checkout");
  if (!process.env.GITHUB_ACTIONS || process.env.RUNNER_OS !== "macOS" || process.env.CI !== "true") {
    fail("manifest preparation requires a GitHub Actions macOS runner");
  }
  if (!path.basename(sidecarRoot).startsWith("maccli-real-distribution-qa-20261005")) {
    fail("sidecar root is not the expected QA harness directory");
  }
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const receiptStats = await stat(receiptDir);
  if (!receiptStats.isDirectory()) fail("receipt path is not a directory");

  const targetDirectory = path.join(repoRoot, QA_RELATIVE);
  await access(targetDirectory, fsConstants.R_OK);
  const sidecarHashes = await compareStagedArtifacts(repoRoot, sidecarRoot);
  const nodePath = await realpath(process.execPath);
  const nodeVersion = await requireCommandVersion(nodePath, EXPECTED_NODE, "Node.js");
  const npmPath = await findExecutable("npm");
  const npmVersion = await requireCommandVersion(npmPath, EXPECTED_NPM, "npm");

  const runId = randomUUID();
  const workDirectory = path.join(receiptDir, `.prepare-${runId}`);
  const cacheDirectory = path.join(workDirectory, "npm-cache");
  const userConfig = path.join(workDirectory, "empty.npmrc");
  const tarballPath = path.join(receiptDir, `openclaw-${VERSION}-${runId}.tgz`);
  const manifestPath = path.join(targetDirectory, "manifest.json");
  const setupReceiptPath = path.join(receiptDir, "setup-receipt.json");
  const setupReceipt = {
    schemaVersion: 1,
    runId,
    preparedAt: timestamp(),
    completed: false,
    productSha,
    packageVersion: VERSION,
    expectedIntegrity: RELEASE_SRI,
    node: { path: nodePath, version: nodeVersion },
    npm: { path: npmPath, version: npmVersion },
    receiptDirectory: receiptDir,
    npmWorkingDirectory: workDirectory,
    npmCommands: [],
    sidecarHashes,
    tarballPath,
    tarballIntegrity: null,
    workDirectoryRemoved: false,
  };

  try {
    await mkdir(workDirectory, { recursive: false, mode: 0o700 });
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    await writeFile(userConfig, "", { flag: "wx", mode: 0o600 });
    const metadata = await npmMetadata(
      npmPath,
      userConfig,
      cacheDirectory,
      workDirectory,
      setupReceipt.npmCommands,
    );
    setupReceipt.npmMetadata = metadata;
    const packResult = await run(npmPath, [
      "pack",
      `openclaw@${VERSION}`,
      "--json",
      `--pack-destination=${receiptDir}`,
      `--registry=https://registry.npmjs.org/`,
      `--userconfig=${userConfig}`,
      `--cache=${cacheDirectory}`,
      "--audit=false",
      "--fund=false",
    ], { cwd: workDirectory });
    setupReceipt.npmCommands.push(commandReceipt("npm pack", packResult));
    if (packResult.code !== 0) fail(commandFailure("npm pack", packResult));
    let packed;
    try {
      packed = JSON.parse(packResult.stdout)?.[0];
    } catch {
      fail("npm pack response was not valid JSON");
    }
    if (packed?.version !== VERSION || packed?.filename !== path.basename(tarballPath)) {
      // npm chooses the package's conventional filename; record that exact file.
      if (packed?.version !== VERSION || typeof packed?.filename !== "string") fail("npm pack returned unexpected package metadata");
      const packedPath = path.join(receiptDir, packed.filename);
      if (!isStrictlyWithin(receiptDir, packedPath)) fail("npm pack produced a tarball outside the receipt directory");
      await access(packedPath, fsConstants.R_OK);
      setupReceipt.tarballPath = packedPath;
    }
    const finalTarballPath = setupReceipt.tarballPath;
    const actualIntegrity = integrityFromHex(await hashFile(finalTarballPath, "sha512"));
    if (actualIntegrity !== RELEASE_SRI || packed?.integrity !== RELEASE_SRI || metadata.integrity !== RELEASE_SRI) {
      fail("downloaded npm tarball bytes did not match the independently pinned SRI");
    }
    setupReceipt.tarballIntegrity = actualIntegrity;
    const manifest = {
      schemaVersion: 1,
      runId,
      createdAt: timestamp(),
      productSha,
      package: { name: "openclaw", version: VERSION, integrity: RELEASE_SRI, tarball: metadata.tarball, shasum: metadata.shasum, engines: metadata.engines },
      toolchain: { node: { path: nodePath, version: nodeVersion }, npm: { path: npmPath, version: npmVersion } },
      receiptDirectory: receiptDir,
      tarballPath: finalTarballPath,
      helperRelativePath: SCRIPT_RELATIVE,
      testRelativePath: TEST_RELATIVE,
      qaRelativePath: QA_RELATIVE,
      stagedArtifactHashes: sidecarHashes,
    };
    await writeJSONExclusive(manifestPath, manifest);
    await chmod(manifestPath, 0o400);
    setupReceipt.manifestPath = manifestPath;
    setupReceipt.manifestSha256 = await hashFile(manifestPath);
    setupReceipt.completed = true;
  } catch (error) {
    setupReceipt.failure = String(error?.message ?? error);
    throw error;
  } finally {
    try {
      await rm(workDirectory, { recursive: true, force: false });
      setupReceipt.workDirectoryRemoved = true;
    } catch {
      setupReceipt.workDirectoryRemoved = false;
    }
    try {
      await writeJSONExclusive(setupReceiptPath, setupReceipt);
    } catch (error) {
      if (!setupReceipt.failure) setupReceipt.failure = `could not write setup receipt: ${String(error?.message ?? error)}`;
      throw error;
    }
  }
  console.log(JSON.stringify({
    result: "manifest-ready",
    productSha,
    version: VERSION,
    integrity: RELEASE_SRI,
    node: setupReceipt.node,
    npm: setupReceipt.npm,
    manifest: setupReceipt.manifestPath,
    receiptDirectory: receiptDir,
  }));
}

function validateRunnerEnvironment() {
  const home = process.env.HOME;
  const fixedHome = process.env.CFFIXED_USER_HOME;
  const temp = process.env.TMPDIR;
  if (process.platform !== "darwin" || !home || !fixedHome || !temp || path.resolve(home) !== path.resolve(fixedHome)) {
    fail("install mode requires the canonical launcher-created macOS HOME and TMPDIR");
  }
  if (process.env.OPENCLAW_PROFILE !== "default") fail("install mode requires the launcher's default app profile");
  return { home: path.resolve(home), temp: path.resolve(temp) };
}

function validateManagedPrefix(managedPrefix, externalPrefix, managedExecutable, home, temp) {
  if (!isStrictlyWithin(home, managedPrefix)) fail("runtime-derived managed prefix is not beneath the launcher HOME");
  if (!isStrictlyWithin(temp, externalPrefix)) fail("external npm prefix is not beneath the launcher TMPDIR");
  if (isWithin(managedPrefix, externalPrefix) || isWithin(externalPrefix, managedPrefix)) {
    fail("managed and external npm prefixes are not distinct disjoint trees");
  }
  if (!isStrictlyWithin(managedPrefix, managedExecutable)) fail("managed executable is not beneath the runtime-derived prefix");
  const stateDirectory = process.env.OPENCLAW_STATE_DIR;
  if (stateDirectory && (path.resolve(stateDirectory) === managedPrefix || isWithin(stateDirectory, managedPrefix) || isWithin(managedPrefix, stateDirectory))) {
    fail("managed prefix overlaps OPENCLAW_STATE_DIR; this harness requires the API-derived profile prefix instead");
  }
  if (path.resolve(managedExecutable) !== path.join(managedPrefix, "bin", "openclaw")) {
    fail("runtime-derived managed executable did not have the expected npm prefix/bin/openclaw shape");
  }
}

async function installedPackage(prefix) {
  const packageDirectory = path.join(prefix, "lib", "node_modules", "openclaw");
  const packageJSON = await readJSON(path.join(packageDirectory, "package.json"));
  if (packageJSON.name !== "openclaw" || packageJSON.version !== VERSION) fail(`installed package under ${prefix} is not openclaw@${VERSION}`);
  const executable = path.join(prefix, "bin", "openclaw");
  await access(executable, fsConstants.X_OK);
  const realExecutable = await realpath(executable);
  const realPackageDirectory = await realpath(packageDirectory);
  if (!isStrictlyWithin(realPackageDirectory, realExecutable)) fail(`npm executable under ${prefix} does not resolve inside the installed package`);
  return {
    prefix,
    packageDirectory: realPackageDirectory,
    executable,
    realExecutable,
    version: packageJSON.version,
    packageName: packageJSON.name,
  };
}

async function ensurePinnedNodeLink(prefix, nodePath) {
  const link = path.join(prefix, "bin", "node");
  const existing = await lstat(link).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error));
  if (existing) {
    if (await realpath(link) !== nodePath) fail(`npm prefix contains an unexpected node executable: ${link}`);
  } else {
    await symlink(nodePath, link);
  }
  const resolved = await realpath(link);
  if (resolved !== nodePath) fail(`npm prefix node link does not resolve to the pinned runner Node: ${link}`);
  return { link, resolved };
}

async function installOne(npm, manifest, prefix, cache, userConfig) {
  const before = await lstat(prefix).then(() => "present", (error) => error.code === "ENOENT" ? "absent" : Promise.reject(error));
  if (before !== "absent") fail(`refusing to overwrite a pre-existing npm prefix: ${prefix}`);
  const result = await run(npm, [
    "install",
    "--global",
    `--prefix=${prefix}`,
    "--no-audit",
    "--no-fund",
    `--registry=https://registry.npmjs.org/`,
    `--userconfig=${userConfig}`,
    `--cache=${cache}`,
    manifest.tarballPath,
  ]);
  if (result.code !== 0) fail(`npm install into an owned prefix failed with exit ${result.code}`);
  const nodeLink = await ensurePinnedNodeLink(prefix, manifest.toolchain.node.path);
  const installation = await installedPackage(prefix);
  return { ...installation, nodeLink, before, npmExitCode: result.code };
}

async function installRealDistributions(args) {
  const manifestPath = absolute(required(args, "manifest"), "--manifest");
  const receiptDir = absolute(required(args, "receipt-dir"), "--receipt-dir");
  const manifest = await readJSON(manifestPath);
  if (manifest.schemaVersion !== 1 || manifest.package?.version !== VERSION || manifest.package?.integrity !== RELEASE_SRI) {
    fail("manifest does not describe the pinned release");
  }
  if (path.resolve(manifest.receiptDirectory) !== receiptDir) fail("manifest receipt directory does not match --receipt-dir");
  if (await realpath(process.execPath) !== manifest.toolchain?.node?.path) fail("suite process is not using the Node binary pinned by the manifest");
  const nodeVersion = await requireCommandVersion(manifest.toolchain.node.path, EXPECTED_NODE, "Node.js");
  const npm = manifest.toolchain?.npm?.path;
  if (await requireCommandVersion(npm, EXPECTED_NPM, "npm") !== manifest.toolchain?.npm?.version) fail("npm differs from the manifest toolchain");
  const tarballIntegrity = integrityFromHex(await hashFile(manifest.tarballPath, "sha512"));
  if (tarballIntegrity !== RELEASE_SRI) fail("verified npm tarball changed after manifest creation");
  const { home, temp } = validateRunnerEnvironment();
  const managedPrefix = absolute(required(args, "managed-prefix"), "--managed-prefix");
  const managedExecutable = absolute(required(args, "managed-executable"), "--managed-executable");
  const externalPrefix = absolute(required(args, "external-prefix"), "--external-prefix");
  validateManagedPrefix(managedPrefix, externalPrefix, managedExecutable, home, temp);
  if (await gitHead(path.resolve(here, "..", "..")) !== manifest.productSha) {
    // The copied helper sits at product/qa/maccli-real-distribution-qa-20261005.
    fail("product checkout HEAD changed since the immutable manifest was prepared");
  }
  const installReceiptPath = path.join(receiptDir, "install-receipt.json");
  const cache = path.join(receiptDir, `.npm-cache-${manifest.runId}`);
  const userConfig = path.join(receiptDir, `.npmrc-${manifest.runId}`);
  const receipt = {
    schemaVersion: 1,
    runId: manifest.runId,
    completed: false,
    installedAt: timestamp(),
    productSha: manifest.productSha,
    packageVersion: VERSION,
    expectedIntegrity: RELEASE_SRI,
    observedTarballIntegrity: tarballIntegrity,
    node: { path: manifest.toolchain.node.path, version: nodeVersion },
    npm: manifest.toolchain.npm,
    managed: { prefix: managedPrefix, executable: managedExecutable, before: "unknown", installed: null },
    external: { prefix: externalPrefix, before: "unknown", installed: null },
    stateDirectory: process.env.OPENCLAW_STATE_DIR ?? null,
    home,
    temp,
    npmCacheRemoved: false,
    tarballRemoved: false,
  };
  let failure;
  try {
    await writeFile(userConfig, "", { flag: "wx", mode: 0o600 });
    await mkdir(cache, { recursive: false, mode: 0o700 });
    const managed = await installOne(manifest.toolchain.npm.path, manifest, managedPrefix, cache, userConfig);
    if (managed.executable !== managedExecutable) fail("installed managed executable path differs from CLIInstaller's runtime-derived path");
    receipt.managed = { prefix: managedPrefix, executable: managedExecutable, before: managed.before, installed: managed };
    const external = await installOne(manifest.toolchain.npm.path, manifest, externalPrefix, cache, userConfig);
    receipt.external = { prefix: externalPrefix, before: external.before, installed: external };
    receipt.distinctInstallations = managedPrefix !== externalPrefix && managed.realExecutable !== external.realExecutable;
    if (!receipt.distinctInstallations) fail("the two npm installations did not produce distinct executable trees");
    receipt.completed = true;
  } catch (error) {
    failure = String(error?.message ?? error);
    receipt.failure = failure;
  } finally {
    try {
      if (isStrictlyWithin(receiptDir, cache)) {
        await rm(cache, { recursive: true, force: true });
        receipt.npmCacheRemoved = true;
      }
    } catch {}
    try {
      await rm(userConfig, { force: true });
    } catch {}
    try {
      if (isStrictlyWithin(receiptDir, manifest.tarballPath)) {
        await rm(manifest.tarballPath, { force: true });
        receipt.tarballRemoved = true;
      }
    } catch {}
    await writeJSONExclusive(installReceiptPath, receipt);
  }
  if (failure) fail(failure);
  console.log(JSON.stringify({
    result: "real-installations-ready",
    runId: manifest.runId,
    version: VERSION,
    integrity: RELEASE_SRI,
    managedPrefix,
    externalPrefix,
    receipt: installReceiptPath,
  }));
}

const externalAllowedFailures = [
  "selectedExecutablePreserved",
  "resolverSelectsExternal",
  "resolverFinalPathIsExternal",
];
const unsetAllowedFailures = ["validatedExecutableRemainsUnset", "validatedVersionRemainsUnset"];
const externalRequiredChecks = [
  "isolatedRunnerHome",
  "managedPathMatchesRuntimeDerivation",
  "distinctInstallations",
  "externalCLIReady",
  "runtimeNodeSearchPathIsPinned",
  "managedRuntimeSearchPathIsPinned",
  "managedCLIReady",
  "externalSelectionSeeded",
  "selectedExecutablePreserved",
  "selectedVersionPreserved",
  "resolverSelectsExternal",
  "resolverFinalPathIsExternal",
];
const unsetRequiredChecks = [
  "isolatedRunnerHome",
  "managedPathMatchesRuntimeDerivation",
  "runtimeNodeSearchPathIsPinned",
  "managedCLIReady",
  "validatedExecutableInitiallyUnset",
  "validatedVersionInitiallyUnset",
  "validatedExecutableRemainsUnset",
  "validatedVersionRemainsUnset",
];

function checkKeysAreTrueExcept(checks, allowedFalse, label) {
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) fail(`${label} checks are missing`);
  for (const [key, value] of Object.entries(checks)) {
    if (value !== true && !(allowedFalse.includes(key) && value === false)) {
      fail(`${label} has an unrelated or non-boolean failed gate: ${key}`);
    }
  }
  for (const key of allowedFalse) {
    if (!Object.hasOwn(checks, key)) fail(`${label} is missing required contract assertion ${key}`);
  }
  return Object.entries(checks).filter(([, value]) => value === false).map(([key]) => key).sort();
}

function expectObservedRegression(cell, name, expected) {
  if (cell.observedRegression?.[name] !== expected) fail(`cell ${cell.cell} did not prove the expected regression observation ${name}`);
}

async function verifyRun(args) {
  const receiptDir = absolute(required(args, "receipt-dir"), "--receipt-dir");
  const expect = required(args, "expect");
  const testExit = Number(required(args, "test-exit"));
  if (!["baseline", "candidate"].includes(expect)) fail("--expect must be baseline or candidate");
  if (!Number.isInteger(testExit) || testExit < 0) fail("--test-exit must be a nonnegative integer");
  const expectedSha = expect === "baseline" ? BASELINE_SHA : CANDIDATE_SHA;
  const setup = await readJSON(path.join(receiptDir, "setup-receipt.json"));
  const install = await readJSON(path.join(receiptDir, "install-receipt.json"));
  const external = await readJSON(path.join(receiptDir, "cell-external-selected.json"));
  const unset = await readJSON(path.join(receiptDir, "cell-initially-unset.json"));
  const cleanup = await readJSON(path.join(receiptDir, "cleanup-receipt.json"));
  const manifest = await readJSON(setup.manifestPath);
  if (!setup.completed || setup.productSha !== expectedSha || manifest.productSha !== expectedSha) fail("setup receipt is incomplete or belongs to the wrong source revision");
  if (!install.completed || install.productSha !== expectedSha || install.runId !== setup.runId || manifest.runId !== setup.runId) fail("install receipt is incomplete or not bound to this manifest");
  if (setup.expectedIntegrity !== RELEASE_SRI || setup.tarballIntegrity !== RELEASE_SRI || manifest.package.integrity !== RELEASE_SRI || install.observedTarballIntegrity !== RELEASE_SRI) {
    fail("pinned npm release integrity is absent or incorrect");
  }
  if (setup.npmMetadata?.shasum !== RELEASE_SHASUM || manifest.package.shasum !== RELEASE_SHASUM) fail("pinned npm release SHA-1 is absent or incorrect");
  if (manifest.package.version !== VERSION || install.packageVersion !== VERSION) fail("pinned npm package version is absent or incorrect");
  if (await gitHead(path.resolve(here, "..", "..")) !== expectedSha) fail("current product checkout HEAD does not match the selected verification lane");
  if (setup.node?.version !== EXPECTED_NODE || setup.npm?.version !== EXPECTED_NPM || install.node?.version !== EXPECTED_NODE || install.npm?.version !== EXPECTED_NPM) {
    fail("toolchain versions do not match the preflight-pinned Node/npm versions");
  }
  if (!setup.workDirectoryRemoved || !install.npmCacheRemoved || !install.tarballRemoved) fail("setup/download/cache cleanup did not complete");
  if (install.managed?.before !== "absent" || install.external?.before !== "absent" || !install.distinctInstallations) fail("the test did not create two distinct fresh npm prefix trees");
  for (const [label, item] of [["managed", install.managed], ["external", install.external]]) {
    if (item.installed?.version !== VERSION || item.installed?.packageName !== "openclaw" || !item.installed?.realExecutable ||
        item.installed?.nodeLink?.resolved !== setup.node?.path || item.installed?.nodeLink?.link !== path.join(item.prefix, "bin", "node")) {
      fail(`${label} prefix lacks a verified real npm installation and pinned real Node link`);
    }
  }
  if (setup.sidecarHashes?.["prepare.mjs"] !== manifest.stagedArtifactHashes?.["prepare.mjs"] ||
      setup.sidecarHashes?.["README.md"] !== manifest.stagedArtifactHashes?.["README.md"] ||
      setup.sidecarHashes?.["CLIInstallerRealDistributionProofTests.swift"] !== manifest.stagedArtifactHashes?.["CLIInstallerRealDistributionProofTests.swift"]) {
    fail("manifest and setup source artifact hashes disagree");
  }
  if (setup.manifestSha256 !== await hashFile(setup.manifestPath)) fail("immutable manifest bytes changed after setup");
  const productRoot = path.resolve(here, "..", "..");
  const stagedFiles = {
    "prepare.mjs": path.join(here, "prepare.mjs"),
    "README.md": path.join(here, "README.md"),
    "CLIInstallerRealDistributionProofTests.swift": path.join(productRoot, TEST_RELATIVE),
  };
  for (const [name, file] of Object.entries(stagedFiles)) {
    if (await hashFile(file) !== manifest.stagedArtifactHashes?.[name]) fail(`staged product artifact changed after setup: ${name}`);
  }
  if (external.runId !== setup.runId || unset.runId !== setup.runId || cleanup.runId !== setup.runId) fail("test receipts are not bound to the setup run");
  if (!external.bodyCompleted || !unset.bodyCompleted || external.productSha !== expectedSha || unset.productSha !== expectedSha) fail("one or more focused test cells did not complete on the expected revision");
  if (external.cell !== "external-selected" || unset.cell !== "initially-unset") fail("unexpected test-cell identity");
  if (JSON.stringify(Object.keys(external.checks ?? {}).sort()) !== JSON.stringify([...externalRequiredChecks].sort()) ||
      JSON.stringify(Object.keys(unset.checks ?? {}).sort()) !== JSON.stringify([...unsetRequiredChecks].sort())) {
    fail("one or more focused test cells omitted or added a gate assertion");
  }
  if (external.packageVersion !== VERSION || unset.packageVersion !== VERSION || external.integrity !== RELEASE_SRI || unset.integrity !== RELEASE_SRI) {
    fail("cell receipts are not bound to the pinned npm release");
  }
  if (external.managedPrefix !== install.managed.prefix || external.externalPrefix !== install.external.prefix ||
      external.managedExecutable !== install.managed.executable || external.externalExecutable !== install.external.executable ||
      external.managedResolvedExecutable !== install.managed.installed.realExecutable ||
      external.externalResolvedExecutable !== install.external.installed.realExecutable ||
      unset.managedPrefix !== install.managed.prefix || unset.managedExecutable !== install.managed.executable) {
    fail("Swift cell paths do not match the two verified npm installation receipts");
  }
  if (external.runtimeNodePath !== path.join(external.externalPrefix, "bin", "node") ||
      external.runtimeNodeFinalPath !== setup.node.path ||
      external.managedRuntimeNodePath !== path.join(install.managed.prefix, "bin", "node") ||
      external.managedRuntimeNodeFinalPath !== setup.node.path ||
      unset.runtimeNodePath !== path.join(install.managed.prefix, "bin", "node") ||
      unset.runtimeNodeFinalPath !== setup.node.path) {
    fail("production-derived CLI runtime search paths did not resolve to the manifest-pinned real Node");
  }
  if (external.selectedExecutableBeforeDiscovery !== external.externalExecutable ||
      external.selectedVersionBeforeDiscovery !== VERSION || external.selectedVersionAfterInspection !== VERSION ||
      unset.validatedExecutableInitiallyUnset !== true || unset.validatedVersionInitiallyUnset !== true) {
    fail("selected/unset state preconditions or recorded versions do not match the real CLI paths");
  }
  if (!cleanup.bodyCompleted || cleanup.productSha !== expectedSha || cleanup.failure !== null || cleanup.helperInstallSucceeded !== true ||
      cleanup.cleanupComplete !== true || cleanup.testIsolationDefaultsRestored !== true || cleanup.testIsolationEnvRestored !== true ||
      cleanup.managedPrefixRemoved !== true || cleanup.tempRootRemoved !== true) {
    fail("test cleanup or TestIsolation restoration did not complete successfully");
  }

  let result;
  if (expect === "candidate") {
    if (testExit !== 0) fail(`candidate focused suite failed with exit ${testExit}`);
    checkKeysAreTrueExcept(external.checks, [], "external-selected cell");
    checkKeysAreTrueExcept(unset.checks, [], "initially-unset cell");
    expectObservedRegression(external, "managedInspectionOverwroteExternalSelection", false);
    expectObservedRegression(unset, "managedInspectionSelectedCLIWhenInitiallyUnset", false);
    if (external.selectedExecutableAfterInspection !== external.externalExecutable ||
        external.resolverExecutable !== external.externalExecutable ||
        external.resolverFinalPath !== external.externalResolvedExecutable ||
        unset.validatedExecutableAfterInspection !== null || unset.validatedVersionAfterInspection !== null) {
      fail("candidate before/after state did not preserve the selected and unset identities");
    }
    result = "candidate-pass";
  } else {
    if (testExit !== 1) fail(`baseline expected only the Swift Testing assertion-failure exit code 1; received ${testExit}`);
    const externalFailures = checkKeysAreTrueExcept(external.checks, externalAllowedFailures, "external-selected cell");
    const unsetFailures = checkKeysAreTrueExcept(unset.checks, unsetAllowedFailures, "initially-unset cell");
    if (JSON.stringify(externalFailures) !== JSON.stringify([...externalAllowedFailures].sort())) fail("baseline did not fail all and only the selected-external identity assertions");
    if (JSON.stringify(unsetFailures) !== JSON.stringify([...unsetAllowedFailures].sort())) fail("baseline did not fail all and only the initially-unset identity assertions");
    expectObservedRegression(external, "managedInspectionOverwroteExternalSelection", true);
    expectObservedRegression(unset, "managedInspectionSelectedCLIWhenInitiallyUnset", true);
    if (external.selectedExecutableAfterInspection !== external.managedExecutable ||
        external.resolverExecutable !== external.managedExecutable ||
        external.resolverFinalPath !== external.managedResolvedExecutable ||
        unset.validatedExecutableAfterInspection !== unset.managedExecutable ||
        unset.validatedVersionAfterInspection !== VERSION) {
      fail("baseline red was not caused by the exact managed-identity mutations under test");
    }
    result = "baseline-expected-regression";
  }
  const summary = {
    schemaVersion: 1,
    result,
    expected: expect,
    productSha: expectedSha,
    testExit,
    package: { name: "openclaw", version: VERSION, integrity: RELEASE_SRI },
    toolchain: setup.node && setup.npm ? { node: setup.node, npm: setup.npm } : null,
    gates: {
      officialReleaseIntegrity: true,
      twoRealDistinctNpmInstallations: true,
      externalSelectionCellComplete: true,
      initiallyUnsetCellComplete: true,
      onlySpecifiedBaselineRegressions: expect === "baseline",
      candidatePreservesBothIdentities: expect === "candidate",
      cleanupAndRestorationComplete: true,
    },
  };
  await writeJSONExclusive(path.join(receiptDir, "verification-summary.json"), summary);
  console.log(JSON.stringify(summary));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "manifest") await createManifest(args);
  else if (args.mode === "install") await installRealDistributions(args);
  else await verifyRun(args);
}

main().catch((error) => {
  console.error(JSON.stringify({ result: "failed", error: String(error?.message ?? error) }));
  process.exitCode = 1;
});
