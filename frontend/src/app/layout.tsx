import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "Simple annotator",
  description: "Patch annotation",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark h-full antialiased ${geist.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-background font-sans text-foreground" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
