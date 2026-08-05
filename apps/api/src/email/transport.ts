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

export type ErrorLogger = {
  error: (payload: Record<string, unknown>, message: string) => void;
};

/**
 * AC-4: hands the send to the event loop and returns immediately, so no
 * response ever waits on it.
 *
 * This is a security control, not a performance one. If a caller awaited the
 * send, only the branch that actually sends would pay the network round-trip
 * to Resend — tens to hundreds of milliseconds on one path while every
 * response body stays identical. Timing that difference reveals which
 * addresses have unverified accounts, which is exactly the enumeration EXP-7
 * removed from login. Dispatching after the reply keeps observable timing flat
 * whatever the transport does.
 *
 * Failures are logged and go no further: every caller has already decided its
 * response cannot depend on whether mail was sent.
 */
export function dispatchVerificationEmail(
  transport: EmailTransport,
  logger: ErrorLogger,
  message: VerificationEmail,
): void {
  void transport.sendVerificationEmail(message).catch((error: unknown) => {
    logger.error(
      { err: error, to: message.to, transport: transport.name },
      'failed to dispatch verification email',
    );
  });
}

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
