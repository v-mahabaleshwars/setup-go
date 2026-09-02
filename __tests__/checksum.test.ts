import {describe, it, expect, afterEach} from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {verifyChecksum} from '../src/checksum.js';

describe('verifyChecksum', () => {
  const tmpFiles: string[] = [];

  function writeTempFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-go-checksum-'));
    const filePath = path.join(dir, 'archive');
    fs.writeFileSync(filePath, content);
    tmpFiles.push(filePath);
    return filePath;
  }

  afterEach(() => {
    while (tmpFiles.length) {
      const filePath = tmpFiles.pop();
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('resolves when the digest matches', async () => {
    const filePath = writeTempFile('hello go');
    const expected = crypto
      .createHash('sha256')
      .update('hello go')
      .digest('hex');

    await expect(verifyChecksum(filePath, expected)).resolves.toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('matches case-insensitively', async () => {
    const filePath = writeTempFile('hello go');
    const expected = crypto
      .createHash('sha256')
      .update('hello go')
      .digest('hex')
      .toUpperCase();

    await expect(verifyChecksum(filePath, expected)).resolves.toBeUndefined();
  });

  it('rejects and removes the file when the digest does not match', async () => {
    const filePath = writeTempFile('hello go');

    await expect(verifyChecksum(filePath, '0'.repeat(64))).rejects.toThrow(
      /Checksum mismatch/
    );

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects when the file does not exist', async () => {
    const filePath = path.join(os.tmpdir(), 'setup-go-checksum-missing-file');

    await expect(verifyChecksum(filePath, '0'.repeat(64))).rejects.toThrow();
  });
});
