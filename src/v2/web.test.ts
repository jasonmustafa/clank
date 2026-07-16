import { describe, expect, it } from "vitest";
import { BoundedWebClient, WebAccessError, type WebHttpResponse, type WebTransport } from "./web.js";

function response(overrides: Partial<WebHttpResponse> = {}): WebHttpResponse {
  return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from("public information"), ...overrides };
}

function harness(options: { addresses?: readonly string[]; responses?: readonly WebHttpResponse[]; error?: Error; maxResponseBytes?: number } = {}) {
  const requests: URL[] = []; let next = 0;
  const transport: WebTransport = {
    request(url) { requests.push(url); if (options.error !== undefined) return Promise.reject(options.error); return Promise.resolve(options.responses?.[next++] ?? response()); },
  };
  const client = new BoundedWebClient({
    lookup: () => Promise.resolve(options.addresses ?? ["93.184.216.34"]),
    transport,
    timeoutMs: 50,
    maxRedirects: 2,
    maxResponseBytes: options.maxResponseBytes ?? 32,
    maxOutputCharacters: 100,
    searchEndpoint: "https://search.example/?q={query}",
  });
  return { client, requests };
}

describe("bounded casual web access", () => {
  it("fetches public HTTP content and bounds model output", async () => {
    const { client } = harness();
    await expect(client.fetch("https://example.com/news")).resolves.toEqual({ url: "https://example.com/news", contentType: "text/plain", text: "public information" });
    const bounded = harness({ maxResponseBytes: 200, responses: [response({ body: Buffer.alloc(150, "a") })] });
    await expect(bounded.client.fetch("https://example.com/long")).resolves.toMatchObject({ text: `${"a".repeat(100)}\n[output truncated]` });
  });

  it.each(["file:///etc/passwd", "ftp://example.com/a", "https://user:pass@example.com/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"])("rejects unsafe URL %s", async (url) => {
    const { client, requests } = harness();
    await expect(client.fetch(url)).rejects.toThrow(WebAccessError);
    expect(requests).toEqual([]);
  });

  it.each(["10.0.0.1", "172.16.1.1", "192.168.1.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "203.0.113.1", "fc00::1", "fe80::1", "2001:db8::1"])("rejects a hostname resolving to %s", async (address) => {
    const { client, requests } = harness({ addresses: [address] });
    await expect(client.fetch("https://public.example/")).rejects.toThrow("public network");
    expect(requests).toEqual([]);
  });

  it("rejects DNS answers containing any private address", async () => {
    const { client, requests } = harness({ addresses: ["93.184.216.34", "10.0.0.1"] });
    await expect(client.fetch("https://public.example/")).rejects.toThrow("public network");
    expect(requests).toEqual([]);
  });

  it("validates every redirect destination and limits redirect chains", async () => {
    const privateRedirect = harness({ responses: [response({ status: 302, headers: { location: "http://localhost/secret" } })] });
    await expect(privateRedirect.client.fetch("https://example.com/")).rejects.toThrow(WebAccessError);
    expect(privateRedirect.requests).toHaveLength(1);

    const loop = harness({ responses: [response({ status: 302, headers: { location: "/two" } }), response({ status: 302, headers: { location: "/three" } }), response({ status: 302, headers: { location: "/four" } })] });
    await expect(loop.client.fetch("https://example.com/one")).rejects.toThrow("redirect limit");
  });

  it("returns safe errors for timeout, oversized, and unsupported content", async () => {
    await expect(harness({ error: new Error("socket details: secret-host") }).client.fetch("https://example.com/")).rejects.toThrow("Web request failed safely");
    await expect(harness({ error: new WebAccessError("Web request timed out") }).client.fetch("https://example.com/")).rejects.toThrow("timed out");
    await expect(harness({ responses: [response({ body: Buffer.alloc(33) })] }).client.fetch("https://example.com/")).rejects.toThrow("size limit");
    await expect(harness({ responses: [response({ headers: { "content-type": "image/png" } })] }).client.fetch("https://example.com/")).rejects.toThrow("Unsupported web content type");
  });

  it("searches through a fixed public endpoint and returns bounded readable results", async () => {
    const html = '<a class="result__a" href="https://example.com/story">Example &amp; Story</a><a class="result__snippet">A useful result.</a>';
    const { client, requests } = harness({ maxResponseBytes: 512, responses: [response({ headers: { "content-type": "text/html" }, body: Buffer.from(html) })] });
    const result = await client.search("latest news");
    expect(result).toContain("Example & Story");
    expect(result).toContain("https://example.com/story");
    expect(requests[0]?.toString()).toBe("https://search.example/?q=latest+news");
  });
});
