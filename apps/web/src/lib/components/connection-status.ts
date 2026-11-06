/** Presentation only: connection ownership and retry decisions stay in the runtime. */
export function connectionStatusLabel(status: string | undefined): string {
  switch (status) {
    case undefined: case "connected": return "Connected";
    case "offline": return "Offline";
    case "available": return "Not connected";
    case "connecting": return "Connecting";
    case "backoff": return "Reconnecting";
    case "blocked": return "Needs attention";
    default: return status;
  }
}
