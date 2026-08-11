/**
 * Test doubles. No test in this workspace makes a network call or touches a
 * native module — the same rule the API side follows by injecting its email
 * transport and extractor.
 */

import type { Transport } from '../api/client';
import type { SessionStorage } from '../session/session';
import type { Session } from '../api/auth';

/** An in-memory stand-in for the keychain. */
export function fakeStorage(initial: string | null = null): SessionStorage & {
  value: string | null;
} {
  return {
    value: initial,
    async read() {
      return this.value;
    },
    async write(token: string) {
      this.value = token;
    },
    async clear() {
      this.value = null;
    },
  };
}

export type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * A transport that answers from a per-path queue and records every call.
 *
 * Counting is the point: AC-5 is an assertion about how MANY times
 * /auth/refresh was called, which no amount of inspecting the final state can
 * substitute for.
 */
export function fakeTransport(routes: Record<string, Reply[] | Reply>) {
  const calls: { path: string; init: RequestInit }[] = [];

  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });

    const configured = routes[path];

    if (configured === undefined) {
      throw new Error(`fakeTransport: no reply configured for ${path}`);
    }

    const reply = Array.isArray(configured)
      ? // The last entry repeats, so a test only lists the replies it cares
        // about rather than padding the queue to match retry counts.
        (configured.length > 1 ? configured.shift()! : configured[0]!)
      : configured;

    return new Response(
      reply.body === undefined ? null : JSON.stringify(reply.body),
      { status: reply.status, headers: reply.headers },
    );
  };

  return {
    transport,
    calls,
    countOf: (path: string) => calls.filter((call) => call.path === path).length,
  };
}

export function session(overrides: Partial<Session> = {}): Session {
  return {
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'someone@example.com',
      createdAt: '2026-08-11T00:00:00.000Z',
    },
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 900,
    ...overrides,
  };
}

/** Collapses the injected sleep so retry tests do not spend real seconds. */
export function instantSleep() {
  const slept: number[] = [];

  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}
