import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Type } from "typebox";

export interface WebHttpResponse { status: number; headers: Readonly<Record<string, string | undefined>>; body: Buffer; }
export interface WebTransport { request(url: URL, options: { addresses: readonly string[]; timeoutMs: number; maxBytes: number }): Promise<WebHttpResponse>; }
export interface BoundedWebOptions {
  lookup?: (hostname: string) => Promise<readonly string[]>;
  transport?: WebTransport;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  maxOutputCharacters?: number;
  searchEndpoint?: string;
}
export interface WebFetchResult { url: string; contentType: string; text: string; }

export class WebAccessError extends Error { override name = "WebAccessError"; }

const DEFAULT_SEARCH = "https://html.duckduckgo.com/html/?q={query}";
const SUPPORTED_TYPES = new Set(["text/plain", "text/html", "text/markdown", "text/csv", "application/json", "application/xml", "text/xml"]);

export class BoundedWebClient {
  readonly #lookup: (hostname: string) => Promise<readonly string[]>;
  readonly #transport: WebTransport;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxResponseBytes: number;
  readonly #maxOutputCharacters: number;
  readonly #searchEndpoint: string;
  constructor(options: BoundedWebOptions = {}) {
    this.#lookup = options.lookup ?? resolveAddresses;
    this.#transport = options.transport ?? new NodeWebTransport();
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#maxRedirects = options.maxRedirects ?? 3;
    this.#maxResponseBytes = options.maxResponseBytes ?? 512_000;
    this.#maxOutputCharacters = options.maxOutputCharacters ?? 12_000;
    this.#searchEndpoint = options.searchEndpoint ?? DEFAULT_SEARCH;
  }

  async fetch(input: string): Promise<WebFetchResult> {
    let url: URL; try { url = new URL(input); } catch { throw new WebAccessError("Invalid web URL"); }
    return this.#fetch(url, 0, Date.now() + this.#timeoutMs);
  }

  async search(query: string): Promise<string> {
    const cleaned = query.trim(); if (cleaned === "") throw new WebAccessError("Search query must not be empty");
    const result = await this.fetch(this.#searchEndpoint.replace("{query}", encodeURIComponent(cleaned).replaceAll("%20", "+")));
    return result.text;
  }

  async #fetch(url: URL, redirects: number, deadline: number): Promise<WebFetchResult> {
    validateUrl(url);
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new WebAccessError("Web request timed out");
    const addresses = isIP(normalizeHostname(url.hostname)) === 0 ? await this.#safeLookup(url.hostname, remaining) : [normalizeHostname(url.hostname)];
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw new WebAccessError("Destination must resolve only to the public network");
    let response: WebHttpResponse;
    try { response = await this.#transport.request(url, { addresses, timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: this.#maxResponseBytes }); }
    catch (error) { if (error instanceof WebAccessError) throw error; throw new WebAccessError("Web request failed safely"); }
    if (response.body.byteLength > this.#maxResponseBytes) throw new WebAccessError("Web response exceeded the configured size limit");
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location; if (location === undefined) throw new WebAccessError("Web redirect had no destination");
      if (redirects >= this.#maxRedirects) throw new WebAccessError("Web redirect limit exceeded");
      return this.#fetch(new URL(location, url), redirects + 1, deadline);
    }
    if (response.status < 200 || response.status >= 300) throw new WebAccessError(`Public web server returned HTTP ${String(response.status)}`);
    const contentType = (response.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!SUPPORTED_TYPES.has(contentType)) throw new WebAccessError("Unsupported web content type");
    const raw = response.body.toString("utf8");
    const text = contentType === "text/html" ? htmlToText(raw) : raw;
    return { url: url.toString(), contentType, text: this.#normalizeAndTruncateOutput(text) };
  }
  async #safeLookup(hostname: string, timeoutMs: number): Promise<readonly string[]> { try { return await Promise.race([this.#lookup(hostname), new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new WebAccessError("Web request timed out")); }, timeoutMs).unref(); })]); } catch (error) { if (error instanceof WebAccessError) throw error; throw new WebAccessError("Public hostname could not be resolved"); } }
  #normalizeAndTruncateOutput(text: string): string { const clean = text.replace(/\r/gu, "").trim(); return clean.length <= this.#maxOutputCharacters ? clean : `${clean.slice(0, this.#maxOutputCharacters)}\n[output truncated]`; }
}

class NodeWebTransport implements WebTransport {
  request(url: URL, options: { addresses: readonly string[]; timeoutMs: number; maxBytes: number }): Promise<WebHttpResponse> {
    return new Promise((resolve, reject) => {
      let addressIndex = 0;
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "GET", headers: { accept: "text/html,text/plain,application/json,application/xml;q=0.8", "user-agent": "Clank bounded web tool" },
        lookup: (_hostname, _options, callback) => { const address = options.addresses[addressIndex++ % options.addresses.length]; if (address === undefined) { callback(new Error("No approved address"), ""); return; } callback(null, address, isIP(address)); },
      }, (response) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > options.maxBytes) { request.destroy(new WebAccessError("Web response exceeded the configured size limit")); } else chunks.push(chunk); });
        response.on("end", () => { clearTimeout(deadlineTimer); resolve({ status: response.statusCode ?? 0, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])), body: Buffer.concat(chunks) }); });
      });
      const deadlineTimer = setTimeout(() => { request.destroy(new WebAccessError("Web request timed out")); }, options.timeoutMs);
      request.setTimeout(options.timeoutMs, () => { request.destroy(new WebAccessError("Web request timed out")); });
      request.on("error", (error) => { clearTimeout(deadlineTimer); reject(error); }); request.end();
    });
  }
}

async function resolveAddresses(hostname: string): Promise<readonly string[]> { return (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address }) => address); }
function validateUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebAccessError("Only public HTTP and HTTPS URLs are supported");
  if (url.username !== "" || url.password !== "") throw new WebAccessError("Credentials in web URLs are not allowed");
  if (url.hostname === "" || url.hostname.toLowerCase() === "localhost" || url.hostname.toLowerCase().endsWith(".localhost")) throw new WebAccessError("Local web destinations are not allowed");
  if (url.port !== "" && Number(url.port) <= 0) throw new WebAccessError("Invalid web port");
}
function normalizeHostname(hostname: string): string { return hostname.replace(/^\[|\]$/gu, ""); }
const disallowedIpv4 = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) disallowedIpv4.addSubnet(network, prefix, "ipv4");
const disallowedIpv6 = new BlockList();
for (const [network, prefix] of [["::", 128], ["::1", 128], ["100::", 64], ["2001:2::", 48], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) disallowedIpv6.addSubnet(network, prefix, "ipv6");
function isPublicAddress(input: string): boolean {
  const address = normalizeHostname(input).toLowerCase();
  if (address.startsWith("::ffff:")) return isPublicAddress(address.slice(7));
  if (isIP(address) === 4) return !disallowedIpv4.check(address, "ipv4");
  if (isIP(address) === 6) return /^2|^3/u.test(address) && !disallowedIpv6.check(address, "ipv6");
  return false;
}
function stripHtml(value: string): string { return value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim(); }
function decodeHtml(value: string): string { return value.replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'"); }
function htmlToText(html: string): string { const linked = html.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, (_match: string, href: string, label: string) => { const destination = readableLink(href); return destination === undefined ? stripHtml(label) : `${stripHtml(label)} (${destination})`; }); return decodeHtml(stripHtml(linked.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/giu, " "))); }
function readableLink(input: string): string | undefined { const href = decodeHtml(input); if (href.startsWith("http://") || href.startsWith("https://")) return href; const absolute = href.startsWith("//") ? `https:${href}` : href.startsWith("/l/") ? `https://duckduckgo.com${href}` : undefined; if (absolute === undefined) return undefined; try { const url = new URL(absolute); return url.searchParams.get("uddg") ?? absolute; } catch { return undefined; } }

const fetchParameters = Type.Object({ url: Type.String({ description: "Public HTTP or HTTPS URL" }) });
const searchParameters = Type.Object({ query: Type.String({ description: "Public web search query" }) });
export function createCasualWebTools(client = new BoundedWebClient()): [ToolDefinition<typeof searchParameters>, ToolDefinition<typeof fetchParameters>] {
  return [
    { name: "web_search", label: "Search public web", description: "Search the public web. Results are text-only and bounded.", parameters: searchParameters, execute: async (_id, { query }) => safeToolResult(() => client.search(query)) },
    { name: "web_fetch", label: "Fetch public web page", description: "Fetch a public HTTP/HTTPS text page. Private networks, unsafe redirects, unsupported content, and large responses are rejected.", parameters: fetchParameters, execute: async (_id, { url }) => safeToolResult(async () => { const result = await client.fetch(url); return `${result.url}\n${result.text}`; }) },
  ];
}
async function safeToolResult(action: () => Promise<string>) { try { return { content: [{ type: "text" as const, text: await action() }], details: {} }; } catch (error) { return { content: [{ type: "text" as const, text: error instanceof WebAccessError ? error.message : "Web request failed safely" }], details: {} }; } }
