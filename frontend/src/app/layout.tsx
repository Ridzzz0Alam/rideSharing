import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Nav } from "@/components/Nav";
import { Providers } from "@/lib/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "RideShare", template: "%s | RideShare" },
  description: "Rider app, driver simulator and fleet map for the RideShare .NET microservices.",
};

export const viewport: Viewport = {
  themeColor: "#1c2230",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Read the gateway URL per request so one Docker image works in every environment
  // (NEXT_PUBLIC_* variables would be frozen at build time).
  await connection();
  const gatewayUrl = process.env.GATEWAY_URL ?? process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080";

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* App Router root layout applies to every page; the rule targets pages/_document. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400..900&display=swap"
        />
      </head>
      <body className="flex h-dvh flex-col overflow-hidden md:flex-row">
        <Providers gatewayUrl={gatewayUrl}>
          <Nav />
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
