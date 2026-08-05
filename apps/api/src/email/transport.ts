/**
 * How verification mail leaves the process.
 *
 * The interface takes only a recipient and the finished URL, so the routes
 * never learn which transport is in use and a real sender can be dropped in
 * without touching them (AC-9).
 */
export type VerificationEmail = {
  to: string;
  verificationUrl: string;
};

export type EmailTransport = {
  readonly name: string;
  sendVerificationEmail: (message: VerificationEmail) => Promise<void>;
};

export type Logger = {
  info: (payload: Record<string, unknown>, message: string) => void;
};

/**
 * The only implementation in this issue (EXP-8 NG-1): it logs the link rather
 * than sending anything. This is what makes the flow exercisable end to end
 * with no API key, no sending domain, and no network in CI.
 *
 * The URL is logged in full and deliberately — in a real transport that would
 * be a credential leak into the logs, which is exactly why the Resend
 * implementation must not copy this line.
 */
export function createConsoleTransport(logger: Logger): EmailTransport {
  return {
    name: 'console',
    async sendVerificationEmail({ to, verificationUrl }) {
      logger.info(
        { to, verificationUrl },
        'Verification email not sent — no transport configured. Open this URL to verify:',
      );
    },
  };
}
