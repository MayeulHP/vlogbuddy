import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ROLLCALL — Everyone brought the footage. Make the film together.",
  description:
    "Drop the trip footage in one place, vote on the best of it together, and cut a film out of it. No accounts, one link.",
};

export const viewport: Viewport = {
  themeColor: "#F0F0EC",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Loaded as a stylesheet rather than through next/font so a build never
          depends on reaching Google. Fallbacks in tailwind.config keep the
          editorial serif / grotesque / mono contrast if it never arrives.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,500..800;1,6..96,500..800&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body className="grain">{children}</body>
    </html>
  );
}
