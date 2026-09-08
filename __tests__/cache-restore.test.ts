import {jest, describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import fs from 'fs';

jest.unstable_mockModule('@actions/cache', () => ({
  saveCache: jest.fn(),
  restoreCache: jest.fn(),
  isFeatureAvailable: jest.fn()
}));

jest.unstable_mockModule('@actions/glob', () => ({
  create: jest.fn(),
  hashFiles: jest.fn()
}));

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  notice: jest.fn(),
  setFailed: jest.fn(),
  setOutput: jest.fn(),
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  getMultilineInput: jest.fn(),
  addPath: jest.fn(),
  exportVariable: jest.fn(),
  saveState: jest.fn(),
  getState: jest.fn(),
  setSecret: jest.fn(),
  isDebug: jest.fn(() => false),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  group: jest.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  toPlatformPath: jest.fn((p: string) => p),
  toWin32Path: jest.fn((p: string) => p),
  toPosixPath: jest.fn((p: string) => p)
}));

// Import real cache-utils (with mocked @actions) before mocking it
const realCacheUtils = await import('../src/cache-utils.js');

jest.unstable_mockModule('../src/cache-utils.js', () => ({
  ...realCacheUtils,
  getCacheDirectoryPath: jest.fn()
}));

const cache = await import('@actions/cache');
const core = await import('@actions/core');
const glob = await import('@actions/glob');
const cacheRestore = await import('../src/cache-restore.js');
const cacheUtils = await import('../src/cache-utils.js');
import type {PackageManagerInfo} from '../src/package-managers.js';

describe('restoreCache', () => {
  let hashFilesSpy: jest.Mock<typeof glob.hashFiles>;
  let getCacheDirectoryPathSpy: jest.Mock<
    typeof cacheUtils.getCacheDirectoryPath
  >;
  let restoreCacheSpy: jest.Mock<typeof cache.restoreCache>;
  let infoSpy: jest.Mock<typeof core.info>;
  let setOutputSpy: jest.Mock<typeof core.setOutput>;

  const versionSpec = '1.13.1';
  const packageManager = 'default';
  const cacheDependencyPath = 'path';

  let originalWorkspace: string | undefined;

  beforeEach(() => {
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/test/workspace';
    //Arrange
    hashFilesSpy = glob.hashFiles as jest.Mock<typeof glob.hashFiles>;
    getCacheDirectoryPathSpy = cacheUtils.getCacheDirectoryPath as jest.Mock<
      typeof cacheUtils.getCacheDirectoryPath
    >;
    restoreCacheSpy = cache.restoreCache as jest.Mock<
      typeof cache.restoreCache
    >;
    infoSpy = core.info as jest.Mock<typeof core.info>;
    setOutputSpy = core.setOutput as jest.Mock<typeof core.setOutput>;

    getCacheDirectoryPathSpy.mockImplementation(
      (PackageManager: PackageManagerInfo) => {
        return Promise.resolve([
          'cache_directory_path',
          'cache_directory_path'
        ]);
      }
    );
  });

  afterEach(() => {
    process.env.GITHUB_WORKSPACE = originalWorkspace;
    jest.restoreAllMocks();
  });

  it('should throw if dependency file path is not valid', async () => {
    // Arrange
    hashFilesSpy.mockImplementation(() => Promise.resolve(''));
    // Act + Assert
    await expect(
      cacheRestore.restoreCache(
        versionSpec,
        packageManager,
        cacheDependencyPath
      )
    ).rejects.toThrow(
      'Some specified paths were not resolved, unable to cache dependencies.'
    );
  });

  it('should inform if cache hit is not occurred', async () => {
    // Arrange
    hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
    restoreCacheSpy.mockImplementation(() => Promise.resolve(''));
    // Act + Assert
    await cacheRestore.restoreCache(
      versionSpec,
      packageManager,
      cacheDependencyPath
    );
    expect(infoSpy).toHaveBeenCalledWith('Cache is not found');
  });

  it('should set output if cache hit is occurred', async () => {
    // Arrange
    hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
    restoreCacheSpy.mockImplementation(() => Promise.resolve('cache_key'));
    // Act + Assert
    await cacheRestore.restoreCache(
      versionSpec,
      packageManager,
      cacheDependencyPath
    );
    expect(setOutputSpy).toHaveBeenCalledWith('cache-hit', true);
  });

  it('should throw if dependency file is not found in workspace', async () => {
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['main.go'] as any);

    await expect(
      cacheRestore.restoreCache(
        versionSpec,
        packageManager
        // No cacheDependencyPath
      )
    ).rejects.toThrow(
      'Dependencies file is not found in /test/workspace. Supported file pattern: go.mod'
    );
  });

  describe('cache key', () => {
    let originalRunnerOs: string | undefined;

    beforeEach(() => {
      originalRunnerOs = process.env.RUNNER_OS;
      // Non-Linux keeps the ImageOS segment out of the key.
      process.env.RUNNER_OS = 'Windows';
      hashFilesSpy.mockImplementation(() => Promise.resolve('file_hash'));
      restoreCacheSpy.mockImplementation(() => Promise.resolve(''));
    });

    afterEach(() => {
      process.env.RUNNER_OS = originalRunnerOs;
    });

    const primaryKeyOf = () => restoreCacheSpy.mock.calls[0][1];

    it('should fall back to the host architecture when none is given', async () => {
      await cacheRestore.restoreCache(
        versionSpec,
        packageManager,
        cacheDependencyPath
      );

      expect(primaryKeyOf()).toContain(`-${process.arch}-`);
    });

    it('should use the requested architecture instead of the host one', async () => {
      await cacheRestore.restoreCache(
        versionSpec,
        packageManager,
        cacheDependencyPath,
        '386'
      );

      expect(primaryKeyOf()).toContain('-386-');
      expect(primaryKeyOf()).not.toContain(`-${process.arch}-`);
    });

    it('should append the cache key suffix', async () => {
      await cacheRestore.restoreCache(
        versionSpec,
        packageManager,
        cacheDependencyPath,
        undefined,
        'linux-arm64'
      );

      expect(primaryKeyOf()).toBe(
        `setup-go-Windows-${process.arch}-go-${versionSpec}-file_hash-linux-arm64`
      );
    });

    it('should ignore a blank cache key suffix', async () => {
      await cacheRestore.restoreCache(
        versionSpec,
        packageManager,
        cacheDependencyPath,
        undefined,
        '   '
      );

      expect(primaryKeyOf()).toBe(
        `setup-go-Windows-${process.arch}-go-${versionSpec}-file_hash`
      );
    });

    it('should throw if the cache key suffix contains a comma', async () => {
      await expect(
        cacheRestore.restoreCache(
          versionSpec,
          packageManager,
          cacheDependencyPath,
          undefined,
          'linux,arm64'
        )
      ).rejects.toThrow("cannot contain commas, but got 'linux,arm64'");
    });

    it('should throw if the cache key suffix makes the key too long', async () => {
      await expect(
        cacheRestore.restoreCache(
          versionSpec,
          packageManager,
          cacheDependencyPath,
          undefined,
          'a'.repeat(513)
        )
      ).rejects.toThrow('the cache service allows at most 512');
    });
  });
});
