import type { Metadata } from "next";
import {
  Bricolage_Grotesque,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
} from "next/font/google";
import "./globals.css";

const uiFont = IBM_Plex_Sans({
  variable: "--font-ui",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const displayFont = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700"],
});
const monoFont = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: {
    default: "Lilac Giveaway Bot",
    template: "%s | Lilac Giveaway Bot",
  },
  description:
    "Discord giveaways with committed participant snapshots and publicly verifiable drand winner selection.",
  metadataBase: new URL(process.env.PUBLIC_BASE_URL ?? "https://giveaway.leni.cat"),
  openGraph: {
    title: "Lilac Giveaway Bot",
    description: "Giveaways whose winner selection can be independently checked.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${uiFont.variable} ${displayFont.variable} ${monoFont.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
