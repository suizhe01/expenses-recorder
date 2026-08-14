/**
 * EXP-37. Every client route, declared once.
 *
 * A client route may never begin with an entry in the API's `API_PREFIXES`
 * (apps/api/src/web.ts). In production the SPA fallback deliberately refuses to
 * serve index.html for API-owned paths, so an unknown one stays a JSON 404
 * rather than an HTML page a client would try to parse as JSON; in development
 * vite.config.ts proxies those same prefixes to Fastify. Either way a colliding
 * client route answers JSON on a direct load, a reload or a shared link, while
 * client-side navigation to it keeps working — which is exactly why the
 * collision shipped twice without anyone noticing.
 *
 * `client-routes.test.ts` reads API_PREFIXES out of the API source and fails on
 * any collision declared here, so this list is what keeps the rule true.
 */
export const CLIENT_ROUTES = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  checkEmail: '/check-email',
  home: '/',
  expenses: '/expense',
  expenseDetail: '/expense/:expenseId',
  settings: '/settings',
  categories: '/settings/categories',
  merchantCorrections: '/settings/merchant-corrections',
  confirmReceipt: '/confirm/:receiptId',
  add: '/add',
  catchAll: '*',
} as const;

/** The confirm screen for one receipt. Built here so the path shape lives in
 *  exactly one place alongside its route pattern. */
export function confirmReceiptPath(receiptId: string): string {
  return `/confirm/${receiptId}`;
}

export function expenseDetailPath(expenseId: string): string {
  return `/expense/${expenseId}`;
}
