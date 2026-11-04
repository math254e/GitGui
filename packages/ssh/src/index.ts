// Public Effect SSH surface. Promise conversion belongs to the Electron adapter.
export { makeSshEnvironmentManager } from "./tunnel.js";
export type { SshEnvironmentManager, SshEnvironmentManagerOptions, SshManagerDependencies } from "./tunnel.js";
export { SshFailure, toSshFailure } from "./errors.js";
export type { SshHostTrustRequest } from "./trust.js";
export { layer as nodeLayer } from "@effect/platform-node/NodeServices";
