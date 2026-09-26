/**
 * Clio error messages reach the audit log and the MCP client, so they must not
 * carry the request's query string (a contact search term is often a name).
 */
import { vi, describe, it, expect, afterEach } from "vitest";

vi.mock("../../auth/oauth.js", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

import { clioGet, clioPost, ClioApiError } from "../clioClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ClioApiError messages", () => {
  it("name the endpoint but not the query string", async () => {
    const fetchMock = stubFetch(422, { message: "Invalid parameter" });

    const err = await clioGet("/contacts.json", { query: "Smith", fields: "id,name" }).catch((e) => e);

    // The request itself still carried the search term.
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("query")).toBe("Smith");
    expect(err).toBeInstanceOf(ClioApiError);
    expect(err.statusCode).toBe(422);
    expect(err.message).toContain("/contacts.json");
    expect(err.message).toContain("Invalid parameter");
    expect(err.message).not.toContain("Smith");
    expect(err.message).not.toContain("?");
    expect(err.message).not.toContain("fields=");
  });

  it("drop the fields selection from write errors too", async () => {
    stubFetch(400, { error: { message: "bad field" } });
    const err = await clioPost("/tasks.json", { data: {} }, { fields: "id,name" }).catch((e) => e);
    expect(err.message).toMatch(/\/tasks\.json: bad field$/);
  });
});
