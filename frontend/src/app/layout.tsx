import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { themeScript } from "@/lib/theme-script";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "JustAnnotate",
  description: "Patch annotation",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${geist.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full bg-background font-sans text-foreground" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
