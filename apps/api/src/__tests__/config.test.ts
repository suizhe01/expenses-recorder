import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../config.js';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/expenses',
  JWT_SECRET: 'a'.repeat(32),
};

describe('parseConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = parseConfig(validEnv);

    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
  });

  // AC-5: a missing required variable is rejected and named.
  it('rejects a missing DATABASE_URL and names the offending variable', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);

    try {
      parseConfig({});
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.join('\n')).toContain('DATABASE_URL');
    }
  });

  it('rejects a malformed DATABASE_URL and names it', () => {
    try {
      parseConfig({ DATABASE_URL: 'mysql://localhost/db' });
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues.join('\n')).toContain('DATABASE_URL');
    }
  });

  it('rejects a non-numeric PORT and names it', () => {
    try {
      parseConfig({ ...validEnv, PORT: 'not-a-number' });
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues.join('\n')).toContain('PORT');
    }
  });

  it('coerces a numeric PORT string', () => {
    expect(parseConfig({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  // AC-12
  it('rejects a missing JWT_SECRET and names it', () => {
    try {
      parseConfig({ DATABASE_URL: validEnv.DATABASE_URL });
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues.join('\n')).toContain('JWT_SECRET');
    }
  });

  it('rejects a JWT_SECRET shorter than 32 characters and names it', () => {
    try {
      parseConfig({ ...validEnv, JWT_SECRET: 'tooshort' });
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      const message = (error as ConfigError).issues.join('\n');
      expect(message).toContain('JWT_SECRET');
      expect(message).toContain('32');
    }
  });
});
