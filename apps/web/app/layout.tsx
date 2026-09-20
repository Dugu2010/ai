import type { ReactNode } from "react";
import "./globals.css";
import { ErrorBoundary } from "../components/error-boundary";
import { ToastProvider } from "../components/toast";

export const metadata = {
  title: "DAI — Your AI coding agent. Browser-based.",
  description: "DAI is a browser-based AI coding agent working inside a real Linux VM: file edits, commands, dev servers and live preview — no terminal required.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#08090a",
};

// Runs before paint to set the theme class, preventing flash of wrong theme.
// Dark (Linear) is the DEFAULT; 'light' (Vercel) is the stored alternative.
const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme-preference');
    var theme = stored === 'light' ? 'light' : 'dark';
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
        {/* Skip-to-content (a11y 2F): first focusable element on every page */}
        <a
          href="#main-content"
          hrefLang="en"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] btn btn-primary"
        >
          Skip to content
        </a>
        <ToastProvider>
          <ErrorBoundary>{children}</ErrorBoundary>
        </ToastProvider>
      </body>
    </html>
  );
}
