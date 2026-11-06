export type RepositoryManagementAction = "open" | "create" | "remove";

/** Server capabilities describe implementation; only the live session grants access. */
export function repositoryManagementAvailability(
  action: RepositoryManagementAction,
  connected: boolean,
  scopes: readonly string[] | null | undefined,
  capabilities: readonly string[] | null | undefined,
): { allowed: boolean; reason: string } {
  if (!connected) return { allowed: false, reason: "The environment is not connected." };
  if (scopes == null) return { allowed: false, reason: "Session authorization is unavailable. Reconnect before managing repositories." };
  if (!scopes.includes("repository:manage")) return { allowed: false, reason: "This session does not grant repository:manage permission." };
  if (capabilities == null) return { allowed: false, reason: "Repository capabilities are unavailable." };
  if (!capabilities.includes(`repositories.${action}`)) return { allowed: false, reason: `This server does not support repository ${action}.` };
  return { allowed: true, reason: "" };
}
