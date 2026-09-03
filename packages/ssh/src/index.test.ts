import { describe, expect, it } from "vitest";
import {
  buildRemoteCommand,
  parseRemoteLaunchResult,
  REMOTE_LAUNCH_SCRIPT,
  REMOTE_STOP_SCRIPT,
} from "./index.js";

describe("SSH remote lifecycle protocol", () => {
  it("parses only complete, valid launch results", () => {
    expect(parseRemoteLaunchResult('noise\nGITGUI_SSH_REMOTE={"remotePort":3774,"serverKind":"managed","reused":true}\n')).toEqual({
      remotePort: 3774,
      serverKind: "managed",
      reused: true,
    });
    expect(parseRemoteLaunchResult('GITGUI_SSH_REMOTE={"remotePort":0,"serverKind":"managed","reused":false}')).toBeNull();
    expect(parseRemoteLaunchResult('GITGUI_SSH_REMOTE={"remotePort":3774,"serverKind":"unknown","reused":false}')).toBeNull();
  });

  it("quotes the lifecycle script and rejects state-key injection", () => {
    const command = buildRemoteCommand("printf '%s' ready", "safe_key-1");
    expect(command).toContain("sh -c");
    expect(command).toContain("safe_key-1");
    expect(() => buildRemoteCommand("true", "bad; rm -rf /")).toThrow("SSH state key is invalid");
  });

  it("persists managed ownership and stops only managed processes", () => {
    expect(REMOTE_LAUNCH_SCRIPT).toContain("printf 'managed\n' >\"$KIND_FILE\"");
    expect(REMOTE_LAUNCH_SCRIPT).toContain('kill -0 "$REMOTE_PID"');
    expect(REMOTE_STOP_SCRIPT).toContain('[ "$REMOTE_KIND" = "managed" ]');
    expect(REMOTE_STOP_SCRIPT).not.toContain('REMOTE_KIND" = "external"');
  });
});
