// DAI dark theme for Monaco. The colors mirror the Linear palette from
// globals.css: canvas #08090a, surfaces #0f1011/#191a1b, text #f7f8f8/#8a8f98,
// accent #5e6ad2. Monaco expects 6-digit hex without the leading "#"; 8-digit
// values keep RGBA.
//
// NOTE: `base: "vs-dark"` is a structural requirement of Monaco's
// editor.IStandaloneThemeData API (a theme must derive from vs | vs-dark |
// hc-black). It is not a rendered fallback: defineTheme("dai-dark") +
// setTheme("dai-dark") below override every visible color, and the editor is
// never mounted with theme "vs-dark".
import type { editor } from "monaco-editor";

export const DAI_DARK_THEME_NAME = "dai-dark";

export const daiDarkTheme: editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6b7280", fontStyle: "italic" },
    { token: "keyword", foreground: "c4b5fd" },
    { token: "string", foreground: "86efac" },
    { token: "number", foreground: "fbbf24" },
    { token: "function", foreground: "93c5fd" },
    { token: "variable", foreground: "f7f8f8" },
    { token: "type", foreground: "c4b5fd" },
  ],
  colors: {
    "editor.background": "#08090a",
    "editor.foreground": "#f7f8f8",
    "editorLineNumber.foreground": "#4a4a4a",
    "editorLineNumber.activeForeground": "#8a8f98",
    "editor.lineHighlightBackground": "#0f1011",
    "editor.selectionBackground": "#5e6ad240",
    "editorCursor.foreground": "#5e6ad2",
    "editorIndentGuide.background": "#1a1a1a",
    "editorWidget.background": "#0f1011",
    "editorWidget.border": "#ffffff0d",
  },
};
