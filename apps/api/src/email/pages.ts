/**
 * The three responses `GET /auth/verify` can produce.
 *
 * Server-rendered and fully self-contained (AC-10): no stylesheet, script,
 * font, or image is fetched from anywhere. These pages open from a mail client
 * on an unpredictable network, so anything external is a blank page waiting to
 * happen — and an external request would leak the visit to a third party.
 *
 * Nothing user-supplied is interpolated into any page. The token is never
 * echoed back, so there is no injection surface and no way for a link to leak
 * itself through a screenshot or a referrer.
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
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #f2f3f5; }
    main { background: #1e2126; border-color: #2e323a; }
    p { color: #a3a9b5; }
  }
`;

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
