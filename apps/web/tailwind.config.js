/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic tokens backed by CSS variables.
        // RGB-triplet form so Tailwind opacity modifiers (/50, /80, /10) work.
        primary: 'rgb(var(--bg-primary-rgb) / <alpha-value>)',
        secondary: 'rgb(var(--bg-secondary-rgb) / <alpha-value>)',
        tertiary: 'rgb(var(--bg-tertiary-rgb) / <alpha-value>)',
        'text-primary': 'rgb(var(--text-primary-rgb) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
        muted: 'rgb(var(--text-muted-rgb) / <alpha-value>)',
        border: 'rgb(var(--border-color-rgb) / <alpha-value>)',
        'accent-primary': 'rgb(var(--accent-primary-rgb) / <alpha-value>)',
        'accent-hover': 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
        'accent-foreground': 'rgb(var(--accent-foreground-rgb) / <alpha-value>)',
      },
      borderColor: {
        DEFAULT: 'rgb(var(--border-color-rgb) / <alpha-value>)',
      },
      backgroundColor: {
        DEFAULT: 'rgb(var(--bg-primary-rgb) / <alpha-value>)',
      },
      textColor: {
        DEFAULT: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        soft: '0 2px 12px rgba(0,0,0,0.08)',
        lift: '0 10px 34px rgba(0,0,0,0.16)',
        glow: '0 0 24px rgba(99,102,241,0.35)',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
      },
    },
  },
  plugins: [],
};
