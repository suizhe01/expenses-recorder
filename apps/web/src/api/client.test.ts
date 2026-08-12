import { createClient, parseRetryAfter } from '@/api/client';
import { describeFailure, SIGN_IN_FAILED } from '@/api/messages';
import { fakeTransport } from '@/test/support';

describe('parseRetryAfter (AC-8)', () => {
  it('reads delay-seconds', () => {
    expect(parseRetryAfter('42')).toBe(42);
  });

  it('reads the HTTP-date form', () => {
    const now = Date.parse('2026-08-11T00:00:00.000Z');
    expect(parseRetryAfter('Tue, 11 Aug 2026 00:00:30 GMT', now)).toBe(30);
  });

  it('returns undefined for a missing header rather than NaN', () => {
    // The failure this excludes is user-visible: an unguarded Number('')
    // is 0 and Number('later') is NaN, and "try again in NaN seconds" ships.
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('never reports a negative wait for a date already past', () => {
    const now = Date.parse('2026-08-11T00:01:00.000Z');
    expect(parseRetryAfter('Tue, 11 Aug 2026 00:00:00 GMT', now)).toBe(0);
  });
});

describe('client', () => {
  it('passes FormData through without setting content-type', async () => {
    const http = fakeTransport({ '/receipts': { status: 201, body: {} } });
    const form = new FormData();
    form.append('file', new File(['receipt'], 'receipt.jpg', { type: 'image/jpeg' }));

    await createClient('', http.transport)('/receipts', { method: 'POST', body: form });

    expect(http.calls[0]!.init.body).toBe(form);
    expect((http.calls[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('sends the bearer header only when a token is supplied', async () => {
    const http = fakeTransport({ '/auth/me': { status: 200, body: {} } });
    const request = createClient('', http.transport);

    await request('/auth/me', { accessToken: 'abc' });
    await request('/auth/me');

    const headers = http.calls.map(
      (call) => (call.init.headers as Record<string, string>).authorization,
    );

    expect(headers).toEqual(['Bearer abc', undefined]);
  });

  it('surfaces the API validation shape', async () => {
    const http = fakeTransport({
      '/auth/register': {
        status: 400,
        body: {
          error: 'Validation failed',
          fields: { password: 'must be at least 12 characters' },
        },
      },
    });

    const result = await createClient('', http.transport)(
      '/auth/register',
      { method: 'POST', body: {} },
    );

    expect(result).toMatchObject({
      kind: 'error',
      status: 400,
      fields: { password: 'must be at least 12 characters' },
    });
  });

  it('carries the code discriminator through', async () => {
    const http = fakeTransport({
      '/auth/login': {
        status: 403,
        body: { error: 'Email not verified', code: 'EMAIL_NOT_VERIFIED' },
      },
    });

    const result = await createClient('', http.transport)(
      '/auth/login',
      { method: 'POST', body: {} },
    );

    expect(result).toMatchObject({ status: 403, code: 'EMAIL_NOT_VERIFIED' });
  });

  it('handles a 204 with no body', async () => {
    const http = fakeTransport({ '/auth/logout': { status: 204 } });

    const result = await createClient('', http.transport)(
      '/auth/logout',
      { method: 'POST', body: {} },
    );

    expect(result.kind).toBe('ok');
  });

  it('reports a transport failure as offline, not as a status', async () => {
    const request = createClient('', async () => {
      throw new TypeError('Network request failed');
    });

    const result = await request('/auth/me');

    expect(result.kind).toBe('offline');
  });

  it('does not choke on an HTML error page', async () => {
    // The verify and reset routes answer HTML, and so does a proxy error page.
    const request = createClient(
      '',
      async () => new Response('<html>502</html>', { status: 502 }),
    );

    const result = await request('/auth/me');

    expect(result).toMatchObject({ kind: 'error', status: 502 });
  });
});

describe('describeFailure', () => {
  /**
   * AC-11. The API answers an identical 401 whether the address is unknown or
   * the password is wrong, so that registration cannot be enumerated. A UI
   * that distinguishes them rebuilds the oracle the server removed.
   */
  it('gives one message for every sign-in 401', () => {
    const unknown = describeFailure(
      { kind: 'error', status: 401, message: 'Invalid email or password' },
      { signInSafe: true },
    );
    const wrongPassword = describeFailure(
      { kind: 'error', status: 401, message: 'Something else entirely' },
      { signInSafe: true },
    );

    expect(unknown).toBe(SIGN_IN_FAILED);
    expect(wrongPassword).toBe(SIGN_IN_FAILED);
  });

  it('counts down from Retry-After on 429', () => {
    expect(
      describeFailure({
        kind: 'error',
        status: 429,
        message: 'Rate limit exceeded',
        retryAfterSeconds: 30,
      }),
    ).toBe('Too many attempts. Try again in 30 seconds.');
  });

  it('says something useful when 429 carries no Retry-After', () => {
    const message = describeFailure({
      kind: 'error',
      status: 429,
      message: 'Rate limit exceeded',
    });

    expect(message).toContain('Too many attempts');
    expect(message).not.toContain('undefined');
    expect(message).not.toContain('NaN');
  });

  it('singularises one second', () => {
    expect(
      describeFailure({
        kind: 'error',
        status: 429,
        message: '',
        retryAfterSeconds: 1,
      }),
    ).toBe('Too many attempts. Try again in 1 second.');
  });
});
