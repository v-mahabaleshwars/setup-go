import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import path from 'path';
import fs from 'fs';

import {State, Outputs} from './constants.js';
import {PackageManagerInfo} from './package-managers.js';
import {getCacheDirectoryPath, getPackageManagerInfo} from './cache-utils.js';

// Limits imposed by the Actions cache service on a cache key.
const CACHE_KEY_MAX_LENGTH = 512;

export const restoreCache = async (
  versionSpec: string,
  packageManager: string,
  cacheDependencyPath?: string,
  architecture?: string,
  cacheKeySuffix?: string
) => {
  const packageManagerInfo = await getPackageManagerInfo(packageManager);
  const platform = process.env.RUNNER_OS;
  const arch = architecture || process.arch;

  const cachePaths = await getCacheDirectoryPath(packageManagerInfo);

  const dependencyFilePath = cacheDependencyPath
    ? cacheDependencyPath
    : findDependencyFile(packageManagerInfo);
  const fileHash = await glob.hashFiles(dependencyFilePath);

  if (!fileHash) {
    throw new Error(
      'Some specified paths were not resolved, unable to cache dependencies.'
    );
  }

  const linuxVersion =
    process.env.RUNNER_OS === 'Linux' ? `${process.env.ImageOS}-` : '';
  const suffix = normalizeCacheKeySuffix(cacheKeySuffix);
  const primaryKey = `setup-go-${platform}-${arch}-${linuxVersion}go-${versionSpec}-${fileHash}${suffix}`;

  if (primaryKey.length > CACHE_KEY_MAX_LENGTH) {
    throw new Error(
      `The generated cache key is ${primaryKey.length} characters long, but the cache service allows at most ${CACHE_KEY_MAX_LENGTH}. Shorten the 'cache-key-suffix' input.`
    );
  }

  core.debug(`primary key is ${primaryKey}`);

  core.saveState(State.CachePrimaryKey, primaryKey);

  const cacheKey = await cache.restoreCache(cachePaths, primaryKey);
  core.setOutput(Outputs.CacheHit, Boolean(cacheKey));

  if (!cacheKey) {
    core.info(`Cache is not found`);
    core.setOutput(Outputs.CacheHit, false);
    return;
  }

  core.saveState(State.CacheMatchedKey, cacheKey);
  core.info(`Cache restored from key: ${cacheKey}`);
};

const normalizeCacheKeySuffix = (cacheKeySuffix?: string): string => {
  const suffix = cacheKeySuffix?.trim();

  if (!suffix) {
    return '';
  }

  // The cache service rejects keys containing commas, so fail with a clear
  // message instead of letting the request fail opaquely later.
  if (suffix.includes(',')) {
    throw new Error(
      `The 'cache-key-suffix' input cannot contain commas, but got '${suffix}'.`
    );
  }

  return `-${suffix}`;
};

const findDependencyFile = (packageManager: PackageManagerInfo) => {
  const dependencyFile = packageManager.dependencyFilePattern;
  const workspace = process.env.GITHUB_WORKSPACE!;
  const rootContent = fs.readdirSync(workspace);

  const goModFileExists = rootContent.includes(dependencyFile);
  if (!goModFileExists) {
    throw new Error(
      `Dependencies file is not found in ${workspace}. Supported file pattern: ${dependencyFile}`
    );
  }

  return path.join(workspace, dependencyFile);
};
