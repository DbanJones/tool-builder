import type { Metadata } from "next";
import type { ReactNode } from "react";

import { TabBar } from "@/components/features/tab-bar/tab-bar";

import "./globals.css";

export const metadata: Metadata = {
  title: "Builder",
  description: "Build production web apps by chatting with Claude.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="flex h-screen flex-col bg-background">
        <TabBar />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </body>
    </html>
  );
}
