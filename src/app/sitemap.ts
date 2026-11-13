import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  // Only public canonical pages; no private drafts, login duplicates or invented timestamps.
  return [{ url: siteUrl }, { url: `${siteUrl}/privacy` }];
}
