import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "@fontsource/momo-trust-display";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "CutlyBG — Remove backgrounds. Keep what matters.",
  description:
    "Remove the background from any image in seconds. Process it privately on your device or upload for a server-side cutout, then download a clean PNG, WEBP or JPG.",
  applicationName: "CutlyBG",
  icons: { icon: "/cutlybg-mark.svg" },
};

export const viewport: Viewport = {
  themeColor: "#f6f6f8",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={plusJakartaSans.variable}>
      <body>{children}</body>
    </html>
  );
}