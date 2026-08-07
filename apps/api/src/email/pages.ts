/**
 * Every page served to a browser: the three outcomes of `GET /auth/verify`,
 * and the password reset form and its results.
 *
 * Server-rendered and fully self-contained (AC-10): no stylesheet, script,
 * font, or image is fetched from anywhere. These pages open from a mail client
 * on an unpredictable network, so anything external is a blank page waiting to
 * happen — and an external request would leak the visit to a third party.
 * Together with the `no-referrer` policy below, that is what keeps the token
 * in the URL from escaping to anyone (EXP-10 NG-8).
 *
 * The verification pages interpolate nothing at all and never echo the token
 * back. The reset form cannot have that property — it must carry the token
 * through a form submission — so it relies on `escapeAttribute` instead
 * (EXP-10 AC-15). Anything user-supplied that reaches a page must go through
 * it; do not interpolate a raw request value here.
 */

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    line-height: 1.5;
    background: #f6f7f9;
    color: #1a1c1f;
  }
  main {
    width: 100%;
    max-width: 26rem;
    background: #fff;
    border: 1px solid #e3e5e9;
    border-radius: 0.75rem;
    padding: 2rem 1.75rem;
    text-align: center;
  }
  .mark { font-size: 2.5rem; line-height: 1; margin-bottom: 0.75rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; font-weight: 600; }
  p { margin: 0; color: #5c6370; }
  p + p { margin-top: 0.75rem; }
  form { margin-top: 1.25rem; text-align: left; }
  label { display: block; font-size: 0.875rem; margin-bottom: 0.25rem; }
  input {
    width: 100%;
    padding: 0.625rem 0.75rem;
    margin-bottom: 0.875rem;
    border: 1px solid #c9ccd4;
    border-radius: 0.5rem;
    font-size: 1rem;
    font-family: inherit;
    background: #fff;
    color: inherit;
  }
  button {
    width: 100%;
    padding: 0.688rem;
    border: 0;
    border-radius: 0.5rem;
    background: #1a1c1f;
    color: #fff;
    font-size: 1rem;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .error {
    margin-top: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    background: #fdecec;
    color: #8c1d1d;
    font-size: 0.875rem;
    text-align: left;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #f2f3f5; }
    main { background: #1e2126; border-color: #2e323a; }
    p { color: #a3a9b5; }
    input { background: #16181c; border-color: #3a3f48; }
    button { background: #f2f3f5; color: #16181c; }
    .error { background: #3a1d1d; color: #f5c6c6; }
  }
`;

/**
 * AC-15. The reset form is the only place a request value reaches a page, and
 * it lands inside a double-quoted attribute, so an unescaped `"` would close
 * it and let the rest of the token become markup.
 *
 * A token this server issued is base64url and contains none of these
 * characters — but the value rendered back is the one the *request* supplied,
 * not the one that was issued, and that is entirely attacker-controlled.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, mark: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <div class="mark" role="presentation">${mark}</div>
  <h1>${heading}</h1>
  ${body}
</main>
</body>
</html>
`;
}

/** AC-6 — the token was valid and the account is now verified. */
export const verifiedPage: string = page(
  'Email verified',
  '&#10003;',
  'Email verified',
  `<p>Your email address is confirmed.</p>
  <p>Return to the app and sign in.</p>`,
);

/** AC-7 — the link was already used. A success, not an error. */
export const alreadyVerifiedPage: string = page(
  'Already verified',
  '&#10003;',
  'Already verified',
  `<p>This address was confirmed earlier, so there is nothing left to do.</p>
  <p>Return to the app and sign in.</p>`,
);

/** AC-8 — missing, unknown, malformed, or expired. */
export const invalidTokenPage: string = page(
  'Link no longer valid',
  '&#9888;',
  'This link is no longer valid',
  `<p>Verification links expire after 24 hours, and requesting a new one
  replaces any earlier link.</p>
  <p>Ask the app to send a fresh verification email, then use the newest
  link.</p>`,
);

/**
 * EXP-10 / AC-6 and AC-8 — the reset form, optionally carrying the error from
 * a rejected submission.
 *
 * The token rides in a hidden field rather than the form's action URL so that
 * a failed submit can re-render without the browser having to keep the query
 * string. `token` is escaped on the way in (AC-15); `error` is not
 * user-supplied — callers pass one of the fixed strings below.
 */
export function resetFormPage(token: string, error?: string): string {
  const errorBlock = error ? `<p class="error">${error}</p>` : '';

  return page(
    'Choose a new password',
    '&#128274;',
    'Choose a new password',
    `<p>Pick something at least 12 characters long.</p>
  ${errorBlock}
  <form method="post" action="/auth/reset-password">
    <input type="hidden" name="token" value="${escapeAttribute(token)}">
    <label for="password">New password</label>
    <input type="password" id="password" name="password" autocomplete="new-password" required>
    <label for="confirmPassword">Confirm new password</label>
    <input type="password" id="confirmPassword" name="confirmPassword" autocomplete="new-password" required>
    <button type="submit">Set new password</button>
  </form>`,
  );
}

/** AC-8 — the two ways a submission can be rejected without spending the token. */
export const PASSWORD_TOO_SHORT = 'That password is too short — use at least 12 characters.';
export const PASSWORDS_DO_NOT_MATCH = 'Those two passwords do not match.';

/** AC-7 — the password was changed, so say what else changed with it. */
export const passwordResetPage: string = page(
  'Password updated',
  '&#10003;',
  'Password updated',
  `<p>Your new password is saved, and your email address is confirmed.</p>
  <p>You have been signed out everywhere else. Return to the app and sign in.</p>`,
);

/** AC-9 — unknown, expired, or already spent. */
export const invalidResetTokenPage: string = page(
  'Link no longer valid',
  '&#9888;',
  'This link is no longer valid',
  `<p>Password reset links expire after 1 hour, can be used only once, and
  requesting a new one replaces any earlier link.</p>
  <p>Ask the app for a fresh reset email, then use the newest link.</p>`,
);
