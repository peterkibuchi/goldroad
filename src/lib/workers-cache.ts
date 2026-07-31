/**
 * Feature-detected access to the Workers Cache API.
 *
 * `caches.default` is a Workers extension: it is absent from the DOM
 * `CacheStorage` type (hence the cast) and absent at runtime under plain
 * vitest/node, so every caller must treat `undefined` as "no cache here" and
 * degrade to computing the value. Returning `undefined` rather than throwing
 * is what lets the cache-using modules stay importable in unit tests.
 *
 * One definition on purpose: five call sites spelled this cast out
 * individually, which left nowhere to add a test seam, instrument hit rate, or
 * centralize key versioning without a five-file edit.
 */
export function defaultCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}
