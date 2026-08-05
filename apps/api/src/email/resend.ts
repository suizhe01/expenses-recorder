import { Resend } from 'resend';
import type { EmailTransport, VerificationEmail } from './transport.js';

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
  };
}
