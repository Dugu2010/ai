import type { ReactNode } from "react";
import "./globals.css";
import { ErrorBoundary } from "../components/error-boundary";
import { ToastProvider } from "../components/toast";

export const metadata = {
  title: "DAI - Decentralized AI",
  description: "Decentralized AI platform for building AI applications",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#111827",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="DAI" />
      </head>
      <body className="bg-primary text-primary antialiased">
        <ToastProvider>
          <ErrorBoundary>{children}</ErrorBoundary>
        </ToastProvider>
      </body>
    </html>
  );
}
