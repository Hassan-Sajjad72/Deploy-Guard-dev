import { Injectable } from "@nestjs/common";
export const AWS_PRICE_LIST_ORIGIN = "https://pricing.us-east-1.amazonaws.com";
async function priceDocument(path: string) {
  const response = await fetch(`${AWS_PRICE_LIST_ORIGIN}${path}`, { signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!response.ok || Number(response.headers.get("content-length") || 0) > 16 * 1024 * 1024) throw new Error("Public price document unavailable.");
  if (!response.body) throw new Error("Public price body unavailable.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 16 * 1024 * 1024) throw new Error("Public price document exceeds limit."); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function publicIpv4HourlyRate(document: any, region: string): number | null {
  if (document?.offerCode !== "AmazonVPC") return null;
  const rates: number[] = [];
  for (const [sku, product] of Object.entries<any>(document.products || {})) {
    if (product?.attributes?.regionCode !== region || !/publicipv4.*inuseaddress/i.test(String(product.attributes.usagetype || ""))) continue;
    for (const term of Object.values<any>(document.terms?.OnDemand?.[sku] || {})) {
      if (!Number.isFinite(Date.parse(term.effectiveDate)) || Date.parse(term.effectiveDate) > Date.now()) continue;
      for (const dimension of Object.values<any>(term.priceDimensions || {})) {
        const value = dimension.pricePerUnit?.USD;
        if (dimension.unit === "Hrs" && dimension.beginRange === "0" && dimension.endRange === "Inf" && typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) rates.push(Number(value));
      }
    }
  }
  return rates.length > 0 && rates.every((rate) => rate === rates[0]) ? rates[0] : null;
}
// Lightsail bundle terms from the official offer file. "1TB" is read as 1000 GB, which never overstates the free allowance.
const quantityGiB = (value: unknown) => { const match = /^(\d+(?:\.\d+)?)(GB|TB)$/.exec(String(value || "")); return match ? Number(match[1]) * (match[2] === "TB" ? 1000 : 1) : null; };
export function lightsailBundleTerms(document: any, region: string, memoryGiB: number) {
  if (document?.offerCode !== "AmazonLightsail") return null;
  const products = Object.entries<any>(document.products || {});
  const bundle = products.find(([, product]) => product?.productFamily === "Lightsail Instance" && product.attributes?.regionCode === region && product.attributes.operatingSystem === "Linux"
    && /-BundleUsage:[0-9.]+GB$/.test(String(product.attributes.usagetype || "")) && quantityGiB(product.attributes.memory) === memoryGiB)?.[1];
  // Transfer products are keyed by fromRegionCode, not regionCode.
  const overage = products.find(([, product]) => product?.attributes?.fromRegionCode === region && /^[A-Z0-9]+-DataXfer-Out-Overage-Bytes$/.test(String(product.attributes.usagetype || "")));
  const storageGiB = quantityGiB(bundle?.attributes?.storage), transferQuotaGiB = quantityGiB(bundle?.attributes?.dataTransferQuota);
  const rates = overage ? Object.values<any>(document.terms?.OnDemand?.[overage[0]] || {}).flatMap((term) => Object.values<any>(term.priceDimensions || {}))
    .filter((dimension) => dimension.unit === "GB" && dimension.beginRange === "0" && /^\d+(?:\.\d+)?$/.test(String(dimension.pricePerUnit?.USD))).map((dimension) => Number(dimension.pricePerUnit.USD)) : [];
  if (storageGiB === null || transferQuotaGiB === null || rates.length !== 1) return null;
  return { storageGiB, transferQuotaGiB, overageUsdPerGiB: rates[0] };
}
@Injectable()
export class AwsPublicPricingService {
  private cache = new Map<string, { value: number; at: number; source: string }>();
  async ipv4(region: string) {
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) return null;
    const cached = this.cache.get(region); if (cached && Date.now() - cached.at < 3600000) return cached;
    try {
      const index = await priceDocument("/offers/v1.0/aws/AmazonVPC/current/region_index.json");
      const path = index?.regions?.[region]?.currentVersionUrl;
      if (typeof path !== "string" || !new RegExp(`^/offers/v1\\.0/aws/AmazonVPC/[0-9]+/${region}/index\\.json$`).test(path)) return null;
      const value = publicIpv4HourlyRate(await priceDocument(path), region); if (value === null) return null;
      const entry = { value, at: Date.now(), source: `${AWS_PRICE_LIST_ORIGIN}${path}` }; this.cache.set(region, entry); return entry;
    } catch { return null; }
  }
  private lightsailCache = new Map<string, { document: any; at: number; source: string }>();
  async lightsail(region: string, memoryGiB: number) {
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) return null;
    try {
      let cached = this.lightsailCache.get(region);
      if (!cached || Date.now() - cached.at >= 3600000) {
        const index = await priceDocument("/offers/v1.0/aws/AmazonLightsail/current/region_index.json");
        const path = index?.regions?.[region]?.currentVersionUrl;
        if (typeof path !== "string" || !new RegExp(`^/offers/v1\\.0/aws/AmazonLightsail/[0-9]+/${region}/index\\.json$`).test(path)) return null;
        cached = { document: await priceDocument(path), at: Date.now(), source: `${AWS_PRICE_LIST_ORIGIN}${path}` }; this.lightsailCache.set(region, cached);
      }
      const terms = lightsailBundleTerms(cached.document, region, memoryGiB);
      return terms ? { ...terms, source: cached.source } : null;
    } catch { return null; }
  }
}
