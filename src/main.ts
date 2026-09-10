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
    const goEnv = readGoEnv(goPath);

    const added = await addBinToPath(goEnv?.['GOPATH']);
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

    core.setOutput(Outputs.GoVersion, parseGoVersion(goVersion));

    if (goEnv) {
      setGoEnvOutputs(goEnv);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

/**
 * Reads the Go environment as a single `go env -json` invocation and logs it.
 *
 * `go env -json` is only available since Go 1.9, and the action still supports
 * older releases, so any failure is reported as a warning and leaves the Go
 * environment outputs unset instead of failing the whole action.
 */
export function readGoEnv(goPath: string): Record<string, string> | undefined {
  let goEnv: Record<string, string>;

  try {
    const rawGoEnv = (cp.execSync(`${goPath} env -json`) || '').toString();
    const parsed: unknown = JSON.parse(rawGoEnv);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("'go env -json' did not return a JSON object");
    }

    goEnv = parsed as Record<string, string>;
  } catch (error) {
    core.warning(
      `Unable to read 'go env -json', the Go environment outputs will not be set: ${
        (error as Error).message
      }`
    );
    return undefined;
  }

  core.startGroup('go env');
  core.info(JSON.stringify(goEnv, null, 2));
  core.endGroup();

  return goEnv;
}

export function setGoEnvOutputs(goEnv: Record<string, string>): void {
  core.setOutput(Outputs.GoEnv, JSON.stringify(goEnv));
  core.setOutput(Outputs.GoPath, goEnv['GOPATH'] ?? '');
  core.setOutput(Outputs.GoBin, goEnv['GOBIN'] ?? '');
  core.setOutput(Outputs.GoRoot, goEnv['GOROOT'] ?? '');
  core.setOutput(Outputs.GoCache, goEnv['GOCACHE'] ?? '');
  core.setOutput(Outputs.GoModCache, goEnv['GOMODCACHE'] ?? '');
  core.setOutput(Outputs.GoOs, goEnv['GOOS'] ?? '');
  core.setOutput(Outputs.GoArch, goEnv['GOARCH'] ?? '');
  core.setOutput(Outputs.GoToolDir, goEnv['GOTOOLDIR'] ?? '');

  // `go env GOBIN` is empty unless it was explicitly configured. In that case
  // `go install` falls back to `$GOPATH/bin`, which is the directory this
  // action creates and adds to the PATH.
  const goPath = goEnv['GOPATH'];
  const goBinPath = goEnv['GOBIN'] || (goPath ? path.join(goPath, 'bin') : '');
  core.setOutput(Outputs.GoBinPath, goBinPath);
}

export async function addBinToPath(goPath?: string): Promise<boolean> {
  let added = false;
  const g = await io.which('go');
  core.debug(`which go :${g}:`);
  if (!g) {
    core.debug('go not in the path');
    return added;
  }

  const gp = goPath ?? cp.execSync('go env GOPATH').toString().trim();
  if (gp) {
    core.debug(`go env GOPATH :${gp}:`);
    if (!fs.existsSync(gp)) {
      // some of the hosted images have go install but not profile dir
      core.debug(`creating ${gp}`);
      await io.mkdirP(gp);
    }

    const bp = path.join(gp, 'bin');
    if (!fs.existsSync(bp)) {
      core.debug(`creating ${bp}`);
      await io.mkdirP(bp);
    }

    core.addPath(bp);
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
