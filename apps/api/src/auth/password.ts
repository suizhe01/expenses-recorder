import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * promisify() collapses scrypt to its three-argument overload and drops the
 * options parameter, so the wrapper is written out by hand.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => {
      if (error) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });
}

/**
 * scrypt parameters. N=16384 r=8 p=1 is the OWASP minimum for scrypt and costs
 * roughly 50ms per hash on commodity hardware — slow enough to hurt an
 * offline attacker, fast enough not to be its own denial of service.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * Self-describing digest: `scrypt$N$r$p$salt$hash`, both parts base64url.
 * Storing the parameters alongside the hash means they can be raised later
 * without invalidating existing passwords.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
  });

  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * A real scrypt digest of a value nobody can log in with, used to spend the
 * same ~50ms on a login for an address that does not exist as on one that
 * does. Without it an unknown email returns instantly while a wrong password
 * pays the hashing cost, and the difference reveals which addresses are
 * registered — the enumeration the identical response bodies exist to prevent.
 *
 * Generated once at module load rather than hard-coded so it always matches
 * the current parameters. The password it encodes is random and discarded.
 */
export const DUMMY_PASSWORD_DIGEST: Promise<string> = hashPassword(
  randomBytes(32).toString('base64url'),
);

/**
 * Constant-time verification. Returns false rather than throwing on a
 * malformed or unrecognised digest, so a corrupted row cannot 500 the login
 * endpoint or distinguish itself from a wrong password.
 */
export async function verifyPassword(
  password: string,
  digest: string,
): Promise<boolean> {
  const parts = digest.split('$');

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;

  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }

  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  let derived: Buffer;

  try {
    derived = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
    });
  } catch {
    return false;
  }

  // Lengths are equal by construction above, but timingSafeEqual throws on a
  // mismatch, so guard rather than let a bad row become a 500.
  if (derived.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
}
