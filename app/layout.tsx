import type { Metadata, Viewport } from "next";
import "@fontsource/ia-writer-quattro/latin-400.css";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Download images",
  description: "A minimal downloader for public Instagram and X media.",
  applicationName: "Download images",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/instagram-mark.svg", type: "image/svg+xml" }],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Download images",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fffefa",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
