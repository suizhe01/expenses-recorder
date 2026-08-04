import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../auth/password.js';

describe('password hashing', () => {
  // AC-6
  it('round-trips a correct password', async () => {
    const digest = await hashPassword('correcthorsebattery');
    expect(await verifyPassword('correcthorsebattery', digest)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const digest = await hashPassword('correcthorsebattery');
    expect(await verifyPassword('correcthorsebatterz', digest)).toBe(false);
  });

  it('never stores the plaintext', async () => {
    const digest = await hashPassword('correcthorsebattery');
    expect(digest).not.toContain('correcthorsebattery');
  });

  it('produces a self-describing digest carrying its parameters', async () => {
    const digest = await hashPassword('correcthorsebattery');
    expect(digest).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
  });

  // AC-6: identical passwords must not produce identical hashes.
  it('salts each hash independently', async () => {
    const a = await hashPassword('correcthorsebattery');
    const b = await hashPassword('correcthorsebattery');

    expect(a).not.toBe(b);
    expect(await verifyPassword('correcthorsebattery', a)).toBe(true);
    expect(await verifyPassword('correcthorsebattery', b)).toBe(true);
  });

  it('returns false rather than throwing on a malformed digest', async () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$16384$8$1$aa$bb']) {
      expect(await verifyPassword('correcthorsebattery', bad)).toBe(false);
    }
  });
});
