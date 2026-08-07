import { Resend } from 'resend';
import type {
  EmailTransport,
  PasswordResetEmail,
  VerificationEmail,
} from './transport.js';

export type ResendTransportOptions = {
  apiKey: string;
  from: string;
};

/**
 * AC-3: plain text only. No HTML part, so there is no second body to keep in
 * sync, nothing to inline for Outlook, and no markup for a spam filter to
 * object to. The link sits on its own line so every mail client linkifies it
 * cleanly.
 */
export function verificationEmailBody(verificationUrl: string): string {
  return [
    'Confirm your email address to finish setting up your expenses-recorder account.',
    '',
    verificationUrl,
    '',
    'This link expires in 24 hours. Requesting a new one replaces it.',
    '',
    "If you didn't sign up, you can ignore this message — no account will be created for you.",
  ].join('\n');
}

export const VERIFICATION_SUBJECT = 'Verify your email address';

/**
 * AC-13: plain text, same as verification, and it states the 1-hour expiry
 * because a reset link is short-lived enough that a user needs to know.
 *
 * The last line matters more here than in the verification mail. Anyone can
 * type another person's address into a reset form, so this message will
 * sometimes reach someone who did not ask for it — it must say plainly that
 * ignoring it is safe and changes nothing.
 */
export function passwordResetEmailBody(resetUrl: string): string {
  return [
    'Someone asked to reset the password on your expenses-recorder account.',
    '',
    resetUrl,
    '',
    'This link expires in 1 hour. Requesting a new one replaces it.',
    '',
    "If you didn't ask for this, you can ignore this message — your password" +
      ' stays as it is and nothing has changed.',
  ].join('\n');
}

export const PASSWORD_RESET_SUBJECT = 'Reset your password';

export function createResendTransport({
  apiKey,
  from,
}: ResendTransportOptions): EmailTransport {
  const client = new Resend(apiKey);

  return {
    name: 'resend',
    async sendVerificationEmail({ to, verificationUrl }: VerificationEmail) {
      const { error } = await client.emails.send({
        from,
        to,
        subject: VERIFICATION_SUBJECT,
        text: verificationEmailBody(verificationUrl),
      });

      // The SDK reports failures in the payload rather than by throwing, so a
      // silent no-send is the default unless this is checked. Throwing here
      // lets the shared dispatch helper log it in one place.
      if (error) {
        throw new Error(`Resend rejected the message: ${error.message}`);
      }
    },
    async sendPasswordResetEmail({ to, resetUrl }: PasswordResetEmail) {
      const { error } = await client.emails.send({
        from,
        to,
        subject: PASSWORD_RESET_SUBJECT,
        text: passwordResetEmailBody(resetUrl),
      });

      if (error) {
        throw new Error(`Resend rejected the message: ${error.message}`);
      }
    },
  };
}
