import type { Metadata } from "next";
import "@fontsource/ia-writer-quattro";
import "./globals.css";

export const metadata: Metadata = {
  title: "insta download",
  description: "A minimal downloader for public Instagram media.",
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
