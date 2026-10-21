import { describe, expect, it } from "vitest";
import { EnvironmentAuthInvalidError, EnvironmentInternalError, EnvironmentOperationForbiddenError, EnvironmentRequestInvalidError, EnvironmentResourceNotFoundError, EnvironmentScopeRequiredError } from "@gitgui/contracts/environment";
import { mapRemoteEnvironmentError } from "./errors.ts";

describe("HTTP connection error classification", () => {
  it.each([
    [new EnvironmentAuthInvalidError({ message: "invalid" }), "ConnectionBlockedError", "authentication"],
    [new EnvironmentScopeRequiredError({ message: "scope", scope: "repository:operate" }), "ConnectionBlockedError", "permission"],
    [new EnvironmentOperationForbiddenError({ message: "forbidden" }), "ConnectionBlockedError", "permission"],
    [new EnvironmentRequestInvalidError({ message: "request" }), "ConnectionBlockedError", "configuration"],
    [new EnvironmentResourceNotFoundError({ message: "missing" }), "ConnectionBlockedError", "configuration"],
    [new EnvironmentInternalError({ message: "unavailable" }), "ConnectionTransientError", "remote-unavailable"],
  ] as const)("classifies %s without a trace ID", (error, tag, reason) => {
    expect(mapRemoteEnvironmentError(error)).toMatchObject({ _tag: tag, reason });
  });
  it("retains a supplied trace ID", () => {
    expect(mapRemoteEnvironmentError(new EnvironmentAuthInvalidError({ message: "invalid", traceId: "trace-1" })).traceId).toBe("trace-1");
  });
});
