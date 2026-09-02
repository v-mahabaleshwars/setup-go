import crypto from 'crypto';
import fs from 'fs';
import * as core from '@actions/core';

// Verifies filePath's sha256 digest against expectedSha256 (as published in
// the go.dev/dl JSON listing). Throws on mismatch and best-effort removes
// the file so a corrupted or tampered archive isn't left for a later step.
export async function verifyChecksum(
  filePath: string,
  expectedSha256: string
): Promise<void> {
  const actual = await hashFile(filePath);
  const expected = expectedSha256.toLowerCase();

  if (actual !== expected) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      core.debug(
        `Failed to remove ${filePath} after checksum mismatch: ${(err as Error).message}`
      );
    }
    throw new Error(
      `Checksum mismatch for ${filePath}: expected sha256 ${expected}, got ${actual}. ` +
        'The downloaded Go archive may be corrupted or tampered with.'
    );
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
