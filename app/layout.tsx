import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "CutlyBG — Remove backgrounds. Keep what matters.",
  description:
    "Remove the background from any image in seconds. Upload a PNG, JPG or WEBP and download a clean transparent PNG.",
  applicationName: "CutlyBG",
  icons: { icon: "/cutlybg-mark.svg" },
};

export const viewport: Viewport = {
  themeColor: "#f6f6f8",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body>{children}</body>
    </html>
  );
}