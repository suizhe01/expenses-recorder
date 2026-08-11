import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { Window } from 'happy-dom';
import { afterEach, beforeAll, expect } from 'vitest';

// The `/vitest` entry point registers itself as a side effect, which did not
// take under this vitest version — extending explicitly is equivalent and
// fails loudly if the import ever breaks.
expect.extend(matchers);

/**
 * Node 26 ships its own `localStorage` global, disabled unless the process was
 * started with `--localstorage-file`. It is installed as an own property of
 * globalThis with the value `undefined`, and because the DOM environment uses
 * globalThis as its window, it **shadows the one happy-dom provides** —
 * `sessionStorage` survives, `localStorage` does not.
 *
 * The fix is to put happy-dom's own implementation back. This is not a
 * hand-written stub: it is the same Storage class the environment would have
 * exposed if Node had not overwritten it, so the adapter is still tested
 * against a real Web Storage rather than a convenient fake.
 */
beforeAll(() => {
  if (typeof window.localStorage === 'undefined') {
    const source = new Window({ url: 'http://localhost:5173' });

    Object.defineProperty(window, 'localStorage', {
      value: source.localStorage,
      configurable: true,
      writable: true,
    });
  }
});

afterEach(() => {
  // The DOM persists between tests otherwise, so a query in one test can match
  // a node another test rendered.
  cleanup();
  window.localStorage?.clear();
});
