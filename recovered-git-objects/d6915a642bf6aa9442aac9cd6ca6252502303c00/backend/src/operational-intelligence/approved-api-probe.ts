import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { safeEndpointPath, validPublicAddress } from "./intelligence-evidence";

export async function approvedApiProbe(origin: string, path: string, method: "GET" | "HEAD", query = "", signal?: AbortSignal) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || isIP(url.hostname) || !/^[A-Za-z0-9.-]+$/.test(url.hostname)) throw new BadRequestException("A verified credential-free HTTPS release origin on port 443 is required");
  safeEndpointPath(path);
  if (query && !/^\?[A-Za-z0-9_=%.-]{1,200}$/.test(query)) throw new BadRequestException("Invalid bounded query probe");
  let dnsDeadline: NodeJS.Timeout;
  const addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => { dnsDeadline = setTimeout(() => reject(new Error("DNS lookup exceeded five seconds")), 5_000); })]).finally(() => clearTimeout(dnsDeadline));
  if (signal?.aborted) throw new Error("Execution deadline reached");
  if (!addresses.length || addresses.some(({ address }) => !validPublicAddress(address))) throw new BadRequestException("Private, local, reserved or mixed DNS targets are forbidden");
  const pinned = addresses[0];
  return new Promise<{ status: number; body: Buffer; contentType: string }>((resolve, reject) => {
    const req = request({ protocol: "https:", hostname: url.hostname, port: 443, path: path + query, method, servername: url.hostname, agent: false, rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family), signal,
      headers: { "User-Agent": "DeployGuard-Approved-API-Assurance/1", Accept: "application/json", "Accept-Encoding": "identity" } }, (res) => {
      let bytes = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65_536) req.destroy(new Error("Response exceeded 64 KB limit")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), contentType: String(res.headers["content-type"] || "") }));
    });
    const deadline = setTimeout(() => req.destroy(new Error("API probe exceeded five seconds")), 5_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });
}
