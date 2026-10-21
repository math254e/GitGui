/**
 * Vendored from T3 Code (`packages/client-runtime/src/errors/network.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - The hint names GitGui instead of T3 Connect, because GitGui has no
 *   managed relay to be blocked by.
 */
export const NETWORK_BLOCKING_HINT =
  "Your DNS or firewall may be blocking the connection. Try another network, such as a different Wi-Fi or mobile data.";

/** For a host that stopped answering on an open connection, so the network path was already working. */
export const UNRESPONSIVE_HOST_HINT = "It may be overloaded, asleep, or off the network.";
