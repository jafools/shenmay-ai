// Unit tests for the shenmayApi fetch helper's error-path handling.
//
// The Playwright e2e suite exercises the happy paths against a live backend,
// but never the failure surfaces (non-2xx bodies, network errors) — those are
// awkward to provoke through the UI. These tests pin that pure logic by
// stubbing global fetch, so a regression in how errors are surfaced to the
// React layer fails fast in CI.

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, type ApiError } from "@/lib/shenmayApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Build a minimal Response-like stub for a JSON body at a given status. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

describe("apiRequest error handling", () => {
  it("throws an ApiError carrying the server's machine code on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, { error: "email_unverified", message: "Verify your email first", code: "email_unverified" }),
      ),
    );

    let caught: ApiError | undefined;
    try {
      await apiRequest("POST", "/api/onboard/register", { email: "x@y.z" });
    } catch (err) {
      caught = err as ApiError;
    }

    expect(caught).toBeInstanceOf(Error);
    // Human-readable `message` is surfaced to the user; `code` stays for branching.
    expect(caught?.message).toBe("Verify your email first");
    expect(caught?.code).toBe("email_unverified");
  });

  it("falls back to `error`, then a generic string, when no `message`/`code` is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));

    let caught: ApiError | undefined;
    try {
      await apiRequest("GET", "/api/portal/me");
    } catch (err) {
      caught = err as ApiError;
    }

    expect(caught?.message).toBe("Request failed");
    expect(caught?.code).toBeNull();
  });

  it("propagates a network/transport error without swallowing it", async () => {
    const networkErr = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkErr));

    await expect(apiRequest("GET", "/api/portal/me")).rejects.toBe(networkErr);
  });
});
