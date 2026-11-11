import type { GitIntegrationRecovery, GitIntegrationState } from "@gitgui/contracts";
import type { ContextMenuItem } from "$lib/contextMenu";

export function integrationRecoveryMenuItems(state: GitIntegrationState, enabled: boolean): ContextMenuItem<GitIntegrationRecovery>[] {
  if (state.kind === "unknown") return [];
  const name = state.kind === "merge" ? "merge" : "rebase";
  return [
    { id: "continue", label: `Continue ${name}`, disabled: !enabled || state.unresolvedPaths.length > 0 },
    ...(state.kind === "rebase" ? [{ id: "skip" as const, label: "Skip current commit…", disabled: !enabled }] : []),
    { id: "abort", label: `Abort ${name}…`, destructive: true, disabled: !enabled },
  ];
}
