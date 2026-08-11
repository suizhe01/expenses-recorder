/**
 * AC-3. One named function per endpoint. No URL appears anywhere else in the
 * app, so a route rename is a single-file change and a typo cannot hide in a
 * screen.
 *
 * The shapes below are copied from apps/api/src/routes/auth.ts. Two of them
 * are load-bearing in ways that are easy to undo from the client side:
 *
 *   - register answers 201 with a MESSAGE ONLY, no tokens and no user object,
 *     because a different shape for a taken address would reveal which
 *     addresses exist. There is nothing to sign in with (AC-10).
 *   - resend-verification always answers the same 202, for the same reason.
 */

import type { ApiRequest, ApiResult } from './client';

export type Session = {
  user: { id: string; email: string; createdAt: string };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type MessageBody = { message: string };
export type User = { id: string; email: string; createdAt: string };

/** The API's discriminator for an account that has not verified its address. */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

export function createAuthApi(request: ApiRequest) {
  return {
    register(email: string, password: string): Promise<ApiResult<MessageBody>> {
      return request<MessageBody>('/auth/register', {
        method: 'POST',
        body: { email, password },
      });
    },

    login(email: string, password: string): Promise<ApiResult<Session>> {
      return request<Session>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
    },

    refresh(refreshToken: string): Promise<ApiResult<Session>> {
      return request<Session>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
      });
    },

    logout(refreshToken: string): Promise<ApiResult<void>> {
      return request<void>('/auth/logout', {
        method: 'POST',
        body: { refreshToken },
      });
    },

    resendVerification(email: string): Promise<ApiResult<MessageBody>> {
      return request<MessageBody>('/auth/resend-verification', {
        method: 'POST',
        body: { email },
      });
    },

    me(accessToken: string): Promise<ApiResult<User>> {
      return request<User>('/auth/me', { accessToken });
    },
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
