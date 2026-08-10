import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { authenticatedUserId, requireAuth } from '../auth/guard.js';
import { fieldErrors } from '../validation.js';
import {
  createCategory,
  listCategories,
  renameCategory,
  softDeleteCategory,
  toCategory,
} from '../categories/categories.js';

/**
 * AC-6. Trimmed first, so "  " is empty rather than two characters, and the
 * stored name never carries leading or trailing space that would make two
 * entries look identical in a picker.
 *
 * NG-2: length only. No character rules — a category may be "Kopi & Roti".
 */
const nameSchema = z.object({
  name: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, { message: 'is required' })
        .max(50, { message: 'must be at most 50 characters' }),
    ),
});

const paramsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * AC-11. One body for an id that does not exist and for one that belongs to
 * somebody else. Telling them apart would confirm another user's id is real —
 * the same reasoning that keeps login and registration from confirming which
 * addresses exist.
 */
const NOT_FOUND = { error: 'Category not found' } as const;

/** AC-7 and AC-9. */
const NAME_TAKEN = { error: 'A category with that name already exists' } as const;


/**
 * EXP-11. Documentation only. No `body`, `querystring`, or **`params`** schema
 * appears here: any of the three switches on Fastify request validation, and a
 * `params` schema in particular would turn a malformed uuid into a 400, where
 * EXP-12 AC-11 requires the same 404 an unknown id gets.
 */
const categoryResponse = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const categoryError = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

const categoryValidationError = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    fields: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

export type CategoryRouteOptions = {
  database: Database;
};

export function registerCategoryRoutes(
  app: FastifyInstance,
  { database }: CategoryRouteOptions,
): void {
  // AC-12: one guard for every route here, rather than repeating jwtVerify.
  app.addHook('preHandler', requireAuth);

  app.get('/categories', {
    schema: {
      tags: ['Categories'],
      summary: 'List live categories, alphabetically',
      security: [{ bearerAuth: [] }],
      response: {
        200: { type: 'array', items: categoryResponse },
        401: categoryError,
      },
    },
  }, async (request, reply) => {
    const rows = await listCategories(database.pool, authenticatedUserId(request));

    return reply.code(200).send(rows.map(toCategory));
  });

  app.post('/categories', {
    schema: {
      tags: ['Categories'],
      summary: 'Create a category',
      description:
        'Names are unique per account, case-insensitively, among live categories only. '
        + 'A name whose only match is a deleted category is accepted.',
      security: [{ bearerAuth: [] }],
      response: {
        201: categoryResponse,
        400: categoryValidationError,
        401: categoryError,
        409: categoryError,
      },
    },
  }, async (request, reply) => {
    const parsed = nameSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const outcome = await createCategory(
      database.pool,
      authenticatedUserId(request),
      parsed.data.name,
    );

    // AC-7 against a live name; AC-8 means a name whose only match is
    // soft-deleted never reaches this branch, because the unique index does
    // not cover deleted rows.
    if (outcome.status === 'conflict') {
      return reply.code(409).send(NAME_TAKEN);
    }

    return reply.code(201).send(toCategory(outcome.category));
  });

  app.patch('/categories/:id', {
    schema: {
      tags: ['Categories'],
      summary: 'Rename a category',
      description:
        'A category belonging to another account answers 404, identically to one that '
        + 'does not exist. Renaming to its own name in a different case is allowed.',
      security: [{ bearerAuth: [] }],
      response: {
        200: categoryResponse,
        400: categoryValidationError,
        401: categoryError,
        404: categoryError,
        409: categoryError,
      },
    },
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    // A malformed uuid cannot name a real category, so it gets the same 404 as
    // one that simply does not exist rather than a distinct validation error.
    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    const parsed = nameSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const outcome = await renameCategory(
      database.pool,
      authenticatedUserId(request),
      params.data.id,
      parsed.data.name,
    );

    if (outcome.status === 'conflict') {
      return reply.code(409).send(NAME_TAKEN);
    }

    if (outcome.status === 'not-found') {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply.code(200).send(toCategory(outcome.category));
  });

  app.delete('/categories/:id', {
    schema: {
      tags: ['Categories'],
      summary: 'Soft delete a category',
      description:
        'The row is kept forever so historical expenses stay labelled, and its name '
        + 'becomes available again. Deleting twice answers 404.',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    const outcome = await softDeleteCategory(
      database.pool,
      authenticatedUserId(request),
      params.data.id,
    );

    // AC-10: an already-deleted category answers exactly as an unknown one
    // does — from outside there is no difference between "gone" and "never
    // yours".
    if (outcome.status === 'not-found') {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply.code(204).send();
  });
}
