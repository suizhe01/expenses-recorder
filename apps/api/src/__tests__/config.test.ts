import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../config.js';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/expenses',
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
});
