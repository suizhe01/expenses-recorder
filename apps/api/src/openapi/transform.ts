import type { FastifySchema, RouteOptions } from 'fastify';
import {
  NO_BODY,
  QUERY_SCHEMAS,
  REQUEST_SCHEMAS,
  type RequestEntry,
} from './request-schemas.js';

/**
 * EXP-22 AC-1. Injects the documented request shapes into the schema
 * `@fastify/swagger` uses to build the document.
 *
 * **Nothing here reaches the request path.** The plugin calls this from its
 * `onRoute` hook purely to generate documentation; Fastify compiled the route's
 * validators from the *original* schema when the route was registered, so a
 * `body` added here is never enforced. Proven by a test that posts a body
 * violating a documented schema and asserts the handler still runs (AC-11) —
 * that test is the load-bearing one, because if this assumption were ever wrong
 * the effect would not be a broken document but four silently broken security
 * behaviours (EXP-11's uniform 401, fixed 202, idempotent 204 and HTML errors).
 */

/** The key both maps use: the method plus the url as Fastify spells it. */
export function routeKey(method: string, url: string): string {
  return `${method} ${url}`;
}

/**
 * `route.method` is a string for an ordinary route and an array for one
 * registered against several methods. This repo has none of the latter, but
 * reading only `route.method[0]` would silently document the wrong thing if one
 * ever appeared.
 */
export function methodsOf(route: Pick<RouteOptions, 'method'>): string[] {
  return Array.isArray(route.method) ? route.method : [route.method];
}

function bodyFor(methods: string[], url: string): RequestEntry | undefined {
  for (const method of methods) {
    const entry = REQUEST_SCHEMAS[routeKey(method, url)];

    if (entry !== undefined) {
      return entry;
    }
  }

  return undefined;
}

function querystringFor(methods: string[], url: string) {
  for (const method of methods) {
    const schema = QUERY_SCHEMAS[routeKey(method, url)];

    if (schema !== undefined) {
      return schema;
    }
  }

  return undefined;
}

export type TransformInput = {
  schema?: FastifySchema;
  url: string;
  route: RouteOptions;
};

export function documentRequests({ schema, url, route }: TransformInput): {
  schema: FastifySchema;
  url: string;
} {
  const methods = methodsOf(route);
  const documented: FastifySchema = { ...schema };

  const entry = bodyFor(methods, url);

  // AC-4. `NO_BODY` is an entry, not an absence, and it emits nothing — so the
  // exhaustiveness test can tell "documented as bodiless" from "forgotten".
  if (entry !== undefined && entry !== NO_BODY) {
    (documented as { body?: unknown }).body = entry.body;

    if (entry.consumes) {
      // AC-5. What the plugin turns into the `content` key of `requestBody`.
      (documented as { consumes?: string[] }).consumes = entry.consumes;
    }
  }

  const querystring = querystringFor(methods, url);

  if (querystring !== undefined) {
    (documented as { querystring?: unknown }).querystring = querystring;
  }

  return { schema: documented, url };
}
