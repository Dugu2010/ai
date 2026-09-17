// Design Tokens for DAI - Consistent UI/UX Foundation

export const colors = {
  // Backgrounds
  bgPrimary: "#0f172a",      // slate-900
  bgSecondary: "#1e293b",     // slate-800
  bgTertiary: "#334155",      // slate-700
  bgElevated: "#1e293b",      // slate-800
  
  // Text
  textPrimary: "#f8fafc",     // slate-50
  textSecondary: "#94a3b8",   // slate-400
  textTertiary: "#64748b",    // slate-500
  textMuted: "#475569",       // slate-600
  
  // Accents
  accentPrimary: "#3b82f6",   // blue-500
  accentPrimaryHover: "#2563eb", // blue-600
  accentSecondary: "#10b981", // emerald-500
  accentTertiary: "#8b5cf6",  // violet-500
  
  // Status colors
  success: "#10b981",
  warning: "#f59e0b",
  error: "#ef4444",
  info: "#3b82f6",
  
  // Borders
  border: "#334155",          // slate-700
  borderLight: "#475569",     // slate-600
  borderDark: "#1e293b",      // slate-800
  
  // Overlay
  overlay: "rgba(0, 0, 0, 0.5)",
  overlayDim: "rgba(0, 0, 0, 0.3)",
} as const;

export const spacing = {
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px",
  xxl: "48px",
} as const;

export const radii = {
  none: "0",
  sm: "4px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  full: "9999px",
} as const;

export const shadows = {
  sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
  lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
  xl: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
  glow: "0 0 15px rgba(59, 130, 246, 0.5)",
} as const;

export const fontSizes = {
  xs: "12px",
  sm: "14px",
  md: "16px",
  lg: "18px",
  xl: "20px",
  xxl: "24px",
} as const;

export const fontWeights = {
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
} as const;

export const transitions = {
  fast: "150ms ease",
  normal: "200ms ease",
  slow: "300ms ease",
} as const;

export const zIndex = {
  dropdown: 100,
  sticky: 200,
  fixed: 300,
  modal: 400,
  popover: 500,
  tooltip: 600,
} as const;

export const breakpoints = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  xxl: "1536px",
} as const;
