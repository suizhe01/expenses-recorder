import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { authenticatedUserId, requireAuth } from '../auth/guard.js';
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

function fieldErrors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  );
}

export type CategoryRouteOptions = {
  database: Database;
};

export function registerCategoryRoutes(
  app: FastifyInstance,
  { database }: CategoryRouteOptions,
): void {
  // AC-12: one guard for every route here, rather than repeating jwtVerify.
  app.addHook('preHandler', requireAuth);

  app.get('/categories', async (request, reply) => {
    const rows = await listCategories(database.pool, authenticatedUserId(request));

    return reply.code(200).send(rows.map(toCategory));
  });

  app.post('/categories', async (request, reply) => {
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

  app.patch('/categories/:id', async (request, reply) => {
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

  app.delete('/categories/:id', async (request, reply) => {
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
