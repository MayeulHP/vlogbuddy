import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/service-worker";

export const metadata: Metadata = {
  title: "ROLLCALL — Everyone brought the footage. Make the film together.",
  description:
    "Drop the trip footage in one place, vote on the best of it together, and cut a film out of it. No accounts, one link.",
  applicationName: "ROLLCALL",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "ROLLCALL",
    // Paper behind the status bar, so a standalone window reads as one sheet.
    statusBarStyle: "default",
  },
  // Phones love turning a share slug into a phone number. They are not.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  // Paper in the light rooms, ink in the dark ones — the masthead is always
  // paper, and that's what sits under the status bar.
  themeColor: "#F0F0EC",
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays available: the cut strip has small type in it and nobody
  // should be locked out of magnifying it.
  maximumScale: 5,
  userScalable: true,
  // Lets the page paint under the notch and the home indicator; every fixed
  // edge below pays for it back with env(safe-area-inset-*).
  viewportFit: "cover",
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
      <body className="grain">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
