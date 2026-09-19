import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Simple annotator",
  description: "Patch annotation",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-zinc-950 text-zinc-50" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
