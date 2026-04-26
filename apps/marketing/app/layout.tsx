import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Builder — chat your way to a deployed web app",
  description:
    "A desktop app that turns a 90-minute conversation with Claude into a working, deployed web app.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
