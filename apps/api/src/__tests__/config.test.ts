import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../config.js';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/expenses',
  JWT_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'http://localhost:3000',
};

describe('parseConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = parseConfig(validEnv);

    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.PORT).toBe(3000);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PADDLEOCR_BASE_URL).toBeUndefined();
    expect(config.PADDLEOCR_TIMEOUT_MS).toBe(5000);
  });

  it('accepts the internal PaddleOCR URL and timeout used by production Compose', () => {
    const config = parseConfig({
      ...validEnv,
      PADDLEOCR_BASE_URL: 'http://paddleocr:8008',
      PADDLEOCR_TIMEOUT_MS: '4000',
    });
    expect(config.PADDLEOCR_BASE_URL).toBe('http://paddleocr:8008');
    expect(config.PADDLEOCR_TIMEOUT_MS).toBe(4000);
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

  // AC-2
  it('rejects a missing PUBLIC_BASE_URL and names it', () => {
    try {
      parseConfig({
        DATABASE_URL: validEnv.DATABASE_URL,
        JWT_SECRET: validEnv.JWT_SECRET,
      });
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues.join('\n')).toContain('PUBLIC_BASE_URL');
    }
  });

  it('rejects a PUBLIC_BASE_URL that is not an absolute http(s) URL', () => {
    for (const bad of ['notaurl', '/auth/verify', 'ftp://x.com', 'example.com']) {
      try {
        parseConfig({ ...validEnv, PUBLIC_BASE_URL: bad });
        expect.unreachable(`parseConfig should have rejected ${bad}`);
      } catch (error) {
        expect((error as ConfigError).issues.join('\n')).toContain('PUBLIC_BASE_URL');
      }
    }
  });

  // AC-2
  it('defaults MAIL_FROM to the Resend test sender', () => {
    expect(parseConfig(validEnv).MAIL_FROM).toBe('onboarding@resend.dev');
  });

  it('rejects a malformed MAIL_FROM and names it', () => {
    try {
      parseConfig({ ...validEnv, MAIL_FROM: 'notanemail' });
      expect.unreachable('parseConfig should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues.join('\n')).toContain('MAIL_FROM');
    }
  });

  // AC-1: docker compose expands an unset ${RESEND_API_KEY:-} to "", which
  // must be treated as absent rather than rejected.
  it('treats an empty RESEND_API_KEY as absent', () => {
    expect(parseConfig({ ...validEnv, RESEND_API_KEY: '' }).RESEND_API_KEY).toBeUndefined();
    expect(parseConfig(validEnv).RESEND_API_KEY).toBeUndefined();
    expect(parseConfig({ ...validEnv, RESEND_API_KEY: 're_abc' }).RESEND_API_KEY).toBe(
      're_abc',
    );
  });

  it('accepts an https PUBLIC_BASE_URL', () => {
    const config = parseConfig({
      ...validEnv,
      PUBLIC_BASE_URL: 'https://expenses.example.com',
    });
    expect(config.PUBLIC_BASE_URL).toBe('https://expenses.example.com');
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

  /**
   * EXP-23 AC-4. The parsing, not the wiring — the rate-limiter behaviour it
   * drives is asserted in auth.test.ts.
   */
  describe('TRUST_PROXY', () => {
    it('defaults to false when absent', () => {
      expect(parseConfig(validEnv).TRUST_PROXY).toBe(false);
    });

    it('treats an empty string as absent, like the optional API keys', () => {
      expect(parseConfig({ ...validEnv, TRUST_PROXY: '' }).TRUST_PROXY).toBe(
        false,
      );
    });

    it('parses "true" as true', () => {
      expect(
        parseConfig({ ...validEnv, TRUST_PROXY: 'true' }).TRUST_PROXY,
      ).toBe(true);
    });

    /**
     * The load-bearing case, and the reason this is an enum rather than
     * `z.coerce.boolean()`. Coercion goes by JavaScript truthiness, so the
     * non-empty string "false" becomes `true` — the configuration would read
     * as off while the API trusted a spoofable header. Every other assertion
     * in this block passes under that bug; only this one fails.
     */
    it('parses "false" as false, not as a truthy string', () => {
      expect(
        parseConfig({ ...validEnv, TRUST_PROXY: 'false' }).TRUST_PROXY,
      ).toBe(false);
    });

    it('rejects any other value and names the variable', () => {
      for (const value of ['1', '0', 'yes', 'no', 'TRUE', 'on']) {
        try {
          parseConfig({ ...validEnv, TRUST_PROXY: value });
          expect.unreachable(`parseConfig should have thrown for "${value}"`);
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).issues.join('\n')).toContain(
            'TRUST_PROXY',
          );
        }
      }
    });
  });
});
