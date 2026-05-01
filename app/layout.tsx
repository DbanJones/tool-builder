import type { Metadata } from "next";
import type { ReactNode } from "react";

import { DemoGuard } from "@/app/components/demo-guard";
import { TabBar } from "@/components/features/tab-bar/tab-bar";
import { DEMO_MODE } from "@/lib/demo";

import "./globals.css";

export const metadata: Metadata = {
  title: DEMO_MODE ? "Dave-Builder (Demo)" : "Dave-Builder",
  description: "Build production web apps by chatting with Dave.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="flex h-screen flex-col bg-background">
        <DemoGuard>
          <TabBar />
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </DemoGuard>
      </body>
    </html>
  );
}
