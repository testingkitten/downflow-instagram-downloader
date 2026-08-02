import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "downflow. Save public Instagram media.",
  description:
    "A focused tool for saving media exposed by public Instagram links.",
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
