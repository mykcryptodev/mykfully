import type { Metadata } from "next";
import { env } from "@/lib/env";

export const siteUrl = env.appUrl;
export const siteTitle = "mykfully — Write, organize and schedule X posts";
export const siteDescription = "Write X posts and threads with a live preview, organize your drafts, and schedule posts in your timezone. An open-source workspace for your next idea.";
const socialImage = {
  url: "/og-mykfully.jpg",
  width: 1920,
  height: 1080,
  alt: "mykfully — free and open source. Deploy your own on Vercel.",
};

export function publicPageMetadata(title: string, description: string, path: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "mykfully",
      title,
      description,
      url: path,
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export const applicationSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "mykfully",
  url: siteUrl,
  description: siteDescription,
  applicationCategory: "ProductivityApplication",
  operatingSystem: "Web",
  image: `${siteUrl}/og-mykfully.jpg`,
  featureList: ["X post and thread editor", "Live post preview", "Autosaved drafts", "Timezone-aware scheduling"],
};
