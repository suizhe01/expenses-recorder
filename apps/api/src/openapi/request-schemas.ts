/**
 * EXP-22. The request bodies and query parameters the OpenAPI document
 * advertises — **for documentation only**.
 *
 * None of this reaches Fastify's validator. `@fastify/swagger`'s `transform`
 * receives a route's schema, and what it returns is used solely to generate the
 * document; the validators were compiled from the original route schema when the
 * route was registered. That is the whole reason this file can exist while
 * EXP-11's ban on `body`/`querystring`/`params` schemas stands: declaring them on
 * a route switches on request validation, which answers 400 before the handler
 * runs and would undo login's uniform 401, resend-verification's fixed 202,
 * logout's idempotent 204 and the HTML error pages.
 *
 * Deliberately NOT under `src/routes/`, like `csv.ts`, `zip.ts` and
 * `validation.ts`: the EXP-11 grep test scans that directory for `body:`,
 * `querystring:` and `params:` at the start of a line, and it should keep
 * scanning route files only. Every schema here is a `body:` waiting to happen,
 * so it must live somewhere the grep never looks.
 *
 * **These schemas are hand-maintained and can drift from the zod schemas that
 * actually validate.** A test asserts the map is exhaustive in both directions,
 * so a new route cannot ship undocumented, but nothing checks field-by-field
 * agreement — deriving from zod was considered and declined (NG-3).
 */

/** A JSON Schema fragment. Loose on purpose: this is documentation, not types. */
export type JsonSchema = Record<string, unknown>;

/**
 * AC-4. A route that takes no body at all.
 *
 * Every non-GET route must appear in the map, this included, so absence is
 * never how a route means "no body" — that way a newly added POST cannot hide
 * behind a blanket exemption for a whole method.
 */
export const NO_BODY = 'no-body' as const;

export type RequestEntry =
  | typeof NO_BODY
  | {
      body: JsonSchema;
      /**
       * AC-5. What Swagger UI will send. `@fastify/swagger` reads `consumes` to
       * decide the `content` key of the generated `requestBody`, so this is what
       * makes the upload render a file picker rather than a JSON box.
       * Defaults to `application/json`.
       */
      consumes?: string[];
    };

const EMAIL: JsonSchema = {
  type: 'string',
  format: 'email',
  description: 'The account address.',
};

/** AC-6. Realistic enough to send as-is; `example` is what Swagger UI prefills. */
const CREDENTIALS: JsonSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: EMAIL,
    password: {
      type: 'string',
      minLength: 12,
      description: 'At least 12 characters. Length only — no composition rules.',
    },
  },
  example: { email: 'you@example.com', password: 'correcthorsebattery' },
};

const REFRESH_TOKEN: JsonSchema = {
  type: 'object',
  required: ['refreshToken'],
  properties: {
    refreshToken: {
      type: 'string',
      description: 'The opaque refresh token issued by login or the previous refresh.',
    },
  },
  example: { refreshToken: 'paste-a-refresh-token-here' },
};

const EMAIL_ONLY: JsonSchema = {
  type: 'object',
  required: ['email'],
  properties: { email: EMAIL },
  example: { email: 'you@example.com' },
};

const CATEGORY_NAME: JsonSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 50,
      description:
        'Trimmed before storing. Unique per account, case-insensitively, among '
        + 'live categories only — deleting a category frees its name.',
    },
  },
  example: { name: 'Coffee' },
};

/** The tax-invoice fields an expense copies at confirm time. */
const EXPENSE_PROPERTIES: Record<string, JsonSchema> = {
  categoryId: { type: 'string', format: 'uuid' },
  totalCents: {
    type: 'integer',
    description: 'Integer cents, and must be positive — a refund is not an expense.',
  },
  purchasedOn: {
    type: 'string',
    format: 'date',
    description: 'YYYY-MM-DD. May not be in the future, judged in Malaysian time.',
  },
  receiptId: {
    type: ['string', 'null'],
    format: 'uuid',
    description:
      'The receipt this expense confirms, or null for a manual entry. A receipt '
      + 'backs at most one live expense.',
  },
  purchasedAtTime: {
    type: ['string', 'null'],
    description: 'HH:MM or HH:MM:SS, 24-hour.',
  },
  subtotalCents: { type: ['integer', 'null'] },
  taxCents: { type: ['integer', 'null'] },
  roundingCents: {
    type: ['integer', 'null'],
    description: 'Signed — receipts round to the nearest 5 sen in either direction.',
  },
  currency: {
    type: 'string',
    description: 'Three letters, stored uppercase. Defaults to MYR.',
  },
  merchantName: { type: ['string', 'null'], maxLength: 255 },
  merchantTaxId: { type: ['string', 'null'], maxLength: 255 },
  receiptNumber: { type: ['string', 'null'], maxLength: 255 },
  paymentMethod: { type: ['string', 'null'], maxLength: 255 },
  note: { type: ['string', 'null'], maxLength: 1000 },
};

/** AC-6. The Master Prawn Mee receipt, which reconciles exactly. */
const EXPENSE_EXAMPLE = {
  categoryId: '00000000-0000-4000-8000-000000000000',
  totalCents: 2685,
  purchasedOn: '2026-08-08',
  purchasedAtTime: '14:31',
  subtotalCents: 2580,
  taxCents: 103,
  roundingCents: 2,
  merchantName: 'Master Prawn Mee',
  merchantTaxId: '202103359487 (TR0254788-K)',
  receiptNumber: 'INV/2608/00291',
  paymentMethod: 'Cash',
};

const CREATE_EXPENSE: JsonSchema = {
  type: 'object',
  required: ['categoryId', 'totalCents', 'purchasedOn'],
  properties: EXPENSE_PROPERTIES,
  example: EXPENSE_EXAMPLE,
};

const PATCH_EXPENSE: JsonSchema = {
  type: 'object',
  properties: EXPENSE_PROPERTIES,
  description:
    'Only the fields present are applied. An explicit null clears an optional '
    + 'field; categoryId, totalCents and purchasedOn cannot be nulled.',
  example: { totalCents: 2700, note: 'split with a colleague' },
};

/**
 * AC-5. The upload. `@fastify/multipart` takes the first file part whatever it
 * is called, and `file` is the name the suite and the manual steps use.
 */
const RECEIPT_UPLOAD: JsonSchema = {
  type: 'object',
  required: ['file'],
  properties: {
    file: {
      type: 'string',
      format: 'binary',
      description:
        "JPEG, PNG, WebP or HEIC, decided by the file's own signature bytes "
        + 'rather than the declared Content-Type. 10 MB maximum.',
    },
  },
};

/**
 * AC-2, AC-3, AC-4. Keyed by `METHOD /fastify/route/url` — the url as Fastify
 * spells it (`:id`), which is what `transform` receives, not the `{id}` form the
 * finished document uses.
 */
export const REQUEST_SCHEMAS: Record<string, RequestEntry> = {
  'POST /auth/register': { body: CREDENTIALS },
  'POST /auth/login': { body: CREDENTIALS },
  'POST /auth/refresh': { body: REFRESH_TOKEN },
  'POST /auth/logout': { body: REFRESH_TOKEN },
  'POST /auth/resend-verification': { body: EMAIL_ONLY },
  'POST /auth/forgot-password': { body: EMAIL_ONLY },
  'POST /auth/reset-password': {
    // AC-5. Submitted by the HTML form the GET route serves, so documenting it
    // as JSON would make Try-it-out send an encoding the real client never uses.
    consumes: ['application/x-www-form-urlencoded'],
    body: {
      type: 'object',
      required: ['token', 'password', 'confirmPassword'],
      properties: {
        token: {
          type: 'string',
          description: 'From the emailed link.',
          example: 'paste-the-token-from-the-link',
        },
        password: { type: 'string', minLength: 12, example: 'correcthorsebattery' },
        confirmPassword: { type: 'string', example: 'correcthorsebattery' },
      },
    },
  },
  'POST /categories': { body: CATEGORY_NAME },
  'PATCH /categories/:id': { body: CATEGORY_NAME },
  'POST /expenses': { body: CREATE_EXPENSE },
  'PATCH /expenses/:id': { body: PATCH_EXPENSE },
  'POST /receipts': {
    consumes: ['multipart/form-data'],
    body: RECEIPT_UPLOAD,
  },
  'POST /exports/token': NO_BODY,
  'DELETE /categories/:id': NO_BODY,
  'DELETE /expenses/:id': NO_BODY,
  'DELETE /receipts/:id': NO_BODY,
};

/**
 * AC-7. The four filters, shared by the list and both exports so the document
 * cannot describe them three different ways.
 *
 * `categoryId` is an **array**, which is what makes Swagger UI offer more than
 * one value — the route accepts a repeated key and normalises it.
 */
const EXPENSE_FILTERS: JsonSchema = {
  type: 'object',
  properties: {
    from: {
      type: 'string',
      format: 'date',
      description: 'YYYY-MM-DD, inclusive. A date in the future is rejected.',
    },
    to: {
      type: 'string',
      format: 'date',
      description:
        'YYYY-MM-DD, inclusive. Omit for an open-ended upper bound — the only '
        + 'way to say "everything from here onwards".',
    },
    categoryId: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      description:
        'Repeat the key to filter by several categories. An unknown, '
        + "soft-deleted, or other account's id answers 422.",
    },
    hasReceipt: {
      type: 'string',
      enum: ['true', 'false'],
      description: 'Whether a receipt is attached. Omit for no filter.',
    },
  },
};

/** AC-8. The emailed links. Documented only — the routes stay tolerant (NG-4). */
const LINK_TOKEN: JsonSchema = {
  type: 'object',
  properties: {
    token: {
      type: 'string',
      description: 'From the emailed link. Unrecognised parameters are ignored here.',
    },
  },
};

/** One-use URL credential for the export download endpoints. */
const EXPORT_FILTERS: JsonSchema = {
  ...EXPENSE_FILTERS,
  properties: {
    ...EXPENSE_FILTERS.properties as Record<string, JsonSchema>,
    token: {
      type: 'string',
      description: 'Single-use download token returned by POST /exports/token. It expires after 60 seconds.',
    },
  },
};

/** AC-7, AC-8. Same key format as `REQUEST_SCHEMAS`. */
export const QUERY_SCHEMAS: Record<string, JsonSchema> = {
  'GET /expenses': EXPENSE_FILTERS,
  'GET /expenses/export.csv': EXPORT_FILTERS,
  'GET /expenses/export.zip': EXPORT_FILTERS,
  'GET /auth/verify': LINK_TOKEN,
  'GET /auth/reset-password': LINK_TOKEN,
};
