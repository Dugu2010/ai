"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  action: () => void | Promise<void>;
  section?: string;
}

interface CommandPaletteProps {
  commands?: Command[];
}

export function CommandPalette({ commands = [] }: CommandPaletteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: Ctrl/Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const search = (value: string) => {
    setQuery(value);
    // Reset the highlight where the query actually changes, rather than in an
    // effect that fires on every render and cascades another one.
    setSelectedIndex(0);
  };

  // Filter commands
  const filteredCommands = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  );

  // Handle selection
  const executeCommand = useCallback(
    async (cmd: Command) => {
      try {
        await cmd.action();
        setIsOpen(false);
        setQuery("");
        setSelectedIndex(0);
      } catch (err) {
        console.error("Command failed:", err);
      }
    },
    []
  );

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (e.key === "Enter" && filteredCommands[selectedIndex]) {
      e.preventDefault();
      executeCommand(filteredCommands[selectedIndex]);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20"
      onClick={() => setIsOpen(false)}
    >
      <div className="absolute inset-0" style={{ background: "rgba(0, 0, 0, 0.5)" }} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace actions"
        className="relative w-full max-w-lg rounded-lg border border-tertiary overflow-hidden"
        style={{ background: "var(--bg-card)", boxShadow: "var(--shadow-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-tertiary">
          <svg
            className="w-5 h-5 text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => search(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to an action…"
            className="flex-1 bg-transparent outline-none text-primary placeholder-muted"
          />
          <kbd className="px-2 py-1 text-xs bg-tertiary rounded text-muted">
            Esc
          </kbd>
        </div>
        <div className="max-h-80 overflow-auto">
          {filteredCommands.length === 0 ? (
             <div className="px-4 py-8 text-center text-muted">
               No commands found
             </div>
          ) : (
            <ul className="py-2">
              {filteredCommands.map((cmd, index) => (
                <li key={cmd.id}>
                  <button
                    onClick={() => executeCommand(cmd)}
                     className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                       index === selectedIndex
                         ? "bg-accent-primary"
                         : "hover:bg-secondary"
                     }`}
                  >
                    {cmd.icon && (
                      <span className="text-muted">{cmd.icon}</span>
                    )}
                    <span className="flex-1 text-primary">{cmd.label}</span>
                    {cmd.shortcut && (
                      <kbd className="px-2 py-1 text-xs bg-tertiary rounded text-muted">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
