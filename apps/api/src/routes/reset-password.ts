import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import {
  dispatchPasswordResetEmail,
  type EmailTransport,
} from '../email/transport.js';
import {
  createPasswordResetToken,
  findPasswordResetToken,
  generatePasswordResetToken,
  isRedeemable,
  isResetThrottled,
  redeemPasswordResetToken,
} from '../auth/password-reset.js';
import { hashPassword } from '../auth/password.js';
import {
  invalidResetTokenPage,
  passwordResetPage,
  resetFormPage,
  PASSWORD_TOO_SHORT,
  PASSWORDS_DO_NOT_MATCH,
} from '../email/pages.js';

/** Same floor as registration. NG-2: length only, no composition rules. */
const MINIMUM_PASSWORD_LENGTH = 12;

const forgotSchema = z.object({
  email: z.string().email(),
});

const submitSchema = z.object({
  token: z.string().min(1),
  password: z.string(),
  confirmPassword: z.string(),
});

const tokenQuerySchema = z.object({
  token: z.string().min(1),
});

/**
 * AC-2: one response for every case, so the endpoint reveals nothing about
 * whether an address is registered. Reusing the wording of the verification
 * resend would be wrong here — this one is about a reset — but the shape and
 * the guarantee are the same.
 */
const RESET_DISPATCHED = {
  message: 'If that address has an account, a reset link is on its way.',
} as const;

const HTML = 'text/html; charset=utf-8';

export type ResetPasswordRouteOptions = {
  config: Config;
  database: Database;
  emailTransport: EmailTransport;
};

export function registerResetPasswordRoutes(
  app: FastifyInstance,
  { config, database, emailTransport }: ResetPasswordRouteOptions,
): void {
  /**
   * Issues a reset link for `email` and dispatches it, if and only if that
   * address belongs to an account outside the reset throttle. Silent in every
   * other case, and never throws: the caller has already committed to its
   * response.
   *
   * Deliberately does NOT check `email_verified`. An unverified user who
   * forgot their password is the person most in need of this — they are stuck
   * behind the login 403 — and redeeming the link clears both problems at once
   * (AC-7).
   */
  async function offerPasswordReset(
    request: FastifyRequest,
    email: string,
  ): Promise<void> {
    try {
      const { rows } = await database.pool.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [email],
      );

      const user = rows[0];

      if (!user) {
        return;
      }

      if (await isResetThrottled(database.pool, user.id)) {
        return;
      }

      const token = generatePasswordResetToken();

      await database.transaction((client) =>
        createPasswordResetToken(client, user.id, token),
      );

      const resetUrl = new URL('/auth/reset-password', config.PUBLIC_BASE_URL);
      resetUrl.searchParams.set('token', token);

      // AC-5: handed to the event loop, so the fixed 202 is never waiting on
      // Resend and cannot be timed apart from the silent paths above.
      dispatchPasswordResetEmail(emailTransport, request.log, {
        to: email,
        resetUrl: resetUrl.toString(),
      });
    } catch (error) {
      request.log.error({ err: error }, 'failed to offer password reset');
    }
  }

  /**
   * AC-2. Identical for an unregistered address, an unverified account, a
   * verified account, and a malformed body. Anything else turns this into the
   * account-enumeration oracle that EXP-7 removed from login.
   */
  app.post('/auth/forgot-password', {
    schema: {
      tags: ['Auth'],
      summary: 'Request a password reset link',
      description:
        'Always answers the same 202 — for a registered address, an unregistered one, and '
        + 'a malformed body alike. Any other shape would make this an account-enumeration '
        + 'oracle. Throttled to one mail a minute, independently of verification mail.',
      response: {
        202: { type: 'object', properties: { message: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const parsed = forgotSchema.safeParse(request.body);

    // Even a malformed body gets the same 202: reporting a validation error
    // for some inputs and not others is itself a signal.
    if (!parsed.success) {
      return reply.code(202).send(RESET_DISPATCHED);
    }

    await offerPasswordReset(request, parsed.data.email);

    return reply.code(202).send(RESET_DISPATCHED);
  });

  /**
   * AC-6. Opened by a human in a browser from a link in an email, so both
   * outcomes are HTML pages rather than JSON.
   */
  app.get('/auth/reset-password', {
    schema: {
      tags: ['Auth'],
      summary: 'The password reset form',
      description:
        'Returns an HTML form when the link is live, and an HTML error page otherwise. '
        + 'Links expire after 1 hour and can be redeemed once. No response schema is '
        + 'declared: these replies are HTML.',
    },
  }, async (request, reply) => {
    const parsed = tokenQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).type(HTML).send(invalidResetTokenPage);
    }

    const row = await findPasswordResetToken(database.pool, parsed.data.token);

    if (!row || !isRedeemable(row)) {
      return reply.code(400).type(HTML).send(invalidResetTokenPage);
    }

    return reply.code(200).type(HTML).send(resetFormPage(parsed.data.token));
  });

  /**
   * AC-7 to AC-9 and AC-14. Submitted by the form above as
   * `application/x-www-form-urlencoded`.
   */
  app.post('/auth/reset-password', {
    schema: {
      tags: ['Auth'],
      summary: 'Submit a new password',
      description:
        'Submitted by the form above as application/x-www-form-urlencoded. Sets the '
        + 'password, revokes every session, and confirms the email address. A rejected '
        + 'password re-renders the form without spending the link. All replies are HTML.',
      consumes: ['application/x-www-form-urlencoded'],
    },
  }, async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);

    // No usable token means there is no form to send back to — the user would
    // have nothing to submit.
    if (!parsed.success) {
      return reply.code(400).type(HTML).send(invalidResetTokenPage);
    }

    const { token, password, confirmPassword } = parsed.data;

    const row = await findPasswordResetToken(database.pool, token);

    // AC-9: the token is checked before the password, so a dead link never
    // renders a form the user would fill in for nothing.
    if (!row || !isRedeemable(row)) {
      return reply.code(400).type(HTML).send(invalidResetTokenPage);
    }

    // AC-8: both rejections re-render the form with the token intact and
    // consume nothing. A single mistyped confirmation must not cost the user
    // their link and force another email.
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      return reply.code(400).type(HTML).send(resetFormPage(token, PASSWORD_TOO_SHORT));
    }

    if (password !== confirmPassword) {
      return reply
        .code(400)
        .type(HTML)
        .send(resetFormPage(token, PASSWORDS_DO_NOT_MATCH));
    }

    // NG-2: no comparison against the stored hash, so reusing the current
    // password is allowed. Someone who only wants to end every session is
    // entitled to do exactly that.
    const passwordHash = await hashPassword(password);

    // AC-7 and AC-14: one transaction. The token claim inside is conditional,
    // so of two simultaneous submissions exactly one writes and the other
    // falls through to the invalid page having changed nothing.
    const outcome = await database.transaction((client) =>
      redeemPasswordResetToken(client, token, passwordHash),
    );

    if (outcome.status !== 'reset') {
      return reply.code(400).type(HTML).send(invalidResetTokenPage);
    }

    return reply.code(200).type(HTML).send(passwordResetPage);
  });
}
