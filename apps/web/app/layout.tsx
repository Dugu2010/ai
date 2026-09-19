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
  themeColor: "#0a0f1a",
};

// Runs before paint to set the theme class, preventing flash of wrong theme.
const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme-preference');
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.classList.add(theme);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="DAI" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-primary text-primary antialiased">
        <ToastProvider>
          <ErrorBoundary>{children}</ErrorBoundary>
        </ToastProvider>
      </body>
    </html>
  );
}
