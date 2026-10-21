/**
 * Vendored from T3 Code (`packages/client-runtime/src/environment/endpoint.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - The `advertisedEndpoint` helper from `@t3tools/shared` is not vendored;
 *   GitGui advertises endpoints through the Rust protocol instead.
 */
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};
