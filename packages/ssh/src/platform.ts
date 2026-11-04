// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0 packages/shared/src/hostProcess.ts.
// Only the platform reference needed by SSH is retained; see docs/ssh-primitives.md.
import * as Context from "effect/Context";
export const HostProcessPlatform = Context.Reference<NodeJS.Platform>("@gitgui/ssh/HostProcessPlatform", { defaultValue: () => process.platform });
