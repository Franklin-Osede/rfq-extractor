import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Loonar RFQ Assistant",
  description:
    "Pre-fill the official Helios TCM from a full RFQ package with evidence-cited compliance suggestions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning on both <html> and <body> because browser
    // extensions (Grammarly, Dark Reader, ColorZilla, etc.) inject data-*
    // attributes and CSS classes after React renders, triggering benign
    // hydration mismatches. This is cosmetic; we are not suppressing real
    // bugs in our own code.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
