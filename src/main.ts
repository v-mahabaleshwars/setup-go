import * as core from '@actions/core';
import * as io from '@actions/io';
import * as installer from './installer.js';
import * as semver from 'semver';
import path from 'path';
import {fileURLToPath} from 'url';
import {restoreCache} from './cache-restore.js';
import {isCacheFeatureAvailable} from './cache-utils.js';
import cp from 'child_process';
import fs from 'fs';
import os from 'os';
import {Architecture} from './types.js';
import {Outputs} from './constants.js';

export async function run() {
  try {
    //
    // versionSpec is optional.  If supplied, install / use from the tool cache
    // If not supplied then problem matchers will still be setup.  Useful for self-hosted.
    //
    const versionSpec = resolveVersionInput();
    setGoToolchain();

    const cache = core.getBooleanInput('cache');
    core.info(`Setup go version spec ${versionSpec}`);

    let arch = core.getInput('architecture') as Architecture;

    if (!arch) {
      arch = os.arch() as Architecture;
    }

    if (versionSpec) {
      const token = core.getInput('token');
      const auth = !token ? undefined : `token ${token}`;

      const checkLatest = core.getBooleanInput('check-latest');

      const goDownloadBaseUrl =
        core.getInput('go-download-base-url') ||
        process.env['GO_DOWNLOAD_BASE_URL'] ||
        undefined;

      if (goDownloadBaseUrl) {
        core.info(`Using custom Go download base URL: ${goDownloadBaseUrl}`);
      }

      const installDir = await installer.getGo(
        versionSpec,
        checkLatest,
        auth,
        arch,
        goDownloadBaseUrl
      );

      const installDirVersion = path.basename(path.dirname(installDir));

      core.addPath(path.join(installDir, 'bin'));
      core.info('Added go to the path');

      const version = installer.makeSemver(installDirVersion);
      // Go versions less than 1.9 require GOROOT to be set
      if (semver.lt(version, '1.9.0')) {
        core.info('Setting GOROOT for Go version < 1.9');
        core.exportVariable('GOROOT', installDir);
      }

      core.info(`Successfully set up Go version ${versionSpec}`);
    } else {
      core.info(
        '[warning]go-version input was not specified. The action will try to use pre-installed version.'
      );
    }

    const goPath = await io.which('go');
    const goVersion = (cp.execSync(`${goPath} version`) || '').toString();
    const goEnvJson = readGoEnv(goPath);

    const added = await addBinToPath(goEnvJson);
    core.debug(`add bin ${added}`);

    if (cache && isCacheFeatureAvailable()) {
      const packageManager = 'default';
      const cacheDependencyPath = core.getInput('cache-dependency-path');
      try {
        await restoreCache(
          parseGoVersion(goVersion),
          packageManager,
          cacheDependencyPath
        );
      } catch (error) {
        core.warning(`Restore cache failed: ${(error as Error).message}`);
      }
    }

    // add problem matchers
    const matchersPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../..',
      'matchers.json'
    );
    core.info(`##[add-matcher]${matchersPath}`);

    // output the version actually being used
    core.info(goVersion);

    core.setOutput('go-version', parseGoVersion(goVersion));

    core.startGroup('go env');
    const goEnv = (cp.execSync(`${goPath} env`) || '').toString();
    core.info(goEnv);
    core.endGroup();

    if (goEnvJson) {
      setGoEnvOutputs(goEnvJson);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

export function readGoEnv(goPath: string): Record<string, string> | undefined {
  try {
    const rawGoEnv = cp.execFileSync(goPath, ['env', '-json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const parsed: unknown = JSON.parse(rawGoEnv);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("'go env -json' did not return a JSON object");
    }

    return parsed as Record<string, string>;
  } catch (error) {
    core.info(
      `Unable to read 'go env -json', the Go environment outputs will not be set: ${
        (error as Error).message
      }`
    );
    return undefined;
  }
}

const goEnvOutputs: ReadonlyArray<[Outputs, string]> = [
  [Outputs.GoPath, 'GOPATH'],
  [Outputs.GoBin, 'GOBIN'],
  [Outputs.GoRoot, 'GOROOT'],
  [Outputs.GoCache, 'GOCACHE'],
  [Outputs.GoModCache, 'GOMODCACHE'],
  [Outputs.GoOs, 'GOOS'],
  [Outputs.GoArch, 'GOARCH'],
  [Outputs.GoToolDir, 'GOTOOLDIR']
];

export function setGoEnvOutputs(goEnv: Record<string, string>): void {
  for (const [output, variable] of goEnvOutputs) {
    core.setOutput(output, goEnv[variable] ?? '');
  }

  core.setOutput(Outputs.GoBinPath, goEnv['GOBIN'] || goPathBin(goEnv));
}

function goPathBin(goEnv: Record<string, string>): string {
  const goPath = (goEnv['GOPATH'] ?? '').split(path.delimiter)[0].trim();
  return goPath ? path.join(goPath, 'bin') : '';
}

function isSamePath(left: string, right: string): boolean {
  return Boolean(left && right) && path.relative(left, right) === '';
}

export async function addBinToPath(
  goEnv?: Record<string, string>
): Promise<boolean> {
  let added = false;
  const g = await io.which('go');
  core.debug(`which go :${g}:`);
  if (!g) {
    core.debug('go not in the path');
    return added;
  }

  const env = goEnv ?? {GOPATH: cp.execSync('go env GOPATH').toString()};
  const gpBin = goPathBin(env);

  if (gpBin) {
    core.debug(`go bin path :${gpBin}:`);
    if (!fs.existsSync(gpBin)) {
      // some of the hosted images have go install but not profile dir
      core.debug(`creating ${gpBin}`);
      await io.mkdirP(gpBin);
    }

    core.addPath(gpBin);
    added = true;
  }

  const goBin = env['GOBIN'];
  if (goBin && !isSamePath(goBin, gpBin)) {
    core.debug(`GOBIN path :${goBin}:`);
    core.addPath(goBin);
    added = true;
  }

  return added;
}

export function parseGoVersion(versionString: string): string {
  // get the installed version as an Action output
  // based on go/src/cmd/go/internal/version/version.go:
  // fmt.Printf("go version %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
  // expecting go<version> for runtime.Version()
  return versionString.split(' ')[2].slice('go'.length);
}

function resolveVersionInput(): string {
  let version = core.getInput('go-version');
  const versionFilePath = core.getInput('go-version-file');

  if (version && versionFilePath) {
    core.warning(
      'Both go-version and go-version-file inputs are specified, only go-version will be used'
    );
  }

  if (version) {
    return version;
  }

  if (versionFilePath) {
    if (!fs.existsSync(versionFilePath)) {
      throw new Error(
        `The specified go version file at: ${versionFilePath} does not exist`
      );
    }
    version = installer.parseGoVersionFile(versionFilePath);
  }

  return version;
}

function setGoToolchain() {
  // docs: https://go.dev/doc/toolchain
  // "local indicates the bundled Go toolchain (the one that shipped with the go command being run)"
  // this is so any 'go' command is run with the selected Go version
  // and doesn't trigger a toolchain download and run commands with that
  // see e.g. issue #424
  // and a similar discussion: https://github.com/docker-library/golang/issues/472.
  // Set the value in process env so any `go` commands run as child-process
  // don't cause toolchain downloads
  process.env[installer.GOTOOLCHAIN_ENV_VAR] = installer.GOTOOLCHAIN_LOCAL_VAL;
  // and in the runner env so e.g. a user running `go mod tidy` won't cause it
  core.exportVariable(
    installer.GOTOOLCHAIN_ENV_VAR,
    installer.GOTOOLCHAIN_LOCAL_VAL
  );
}
