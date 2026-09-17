"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  action: () => void | Promise<void>;
  section?: string;
}

interface CommandPaletteProps {
  projectId: string;
  commands?: Command[];
}

export function CommandPalette({ projectId, commands = [] }: CommandPaletteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

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

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg bg-secondary rounded-lg shadow-xl border border-tertiary overflow-hidden"
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
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands..."
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

// Default commands for project page
export function getDefaultProjectCommands(projectId: string): Command[] {
  return [
    {
      id: "open-settings",
      label: "Open Settings",
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
      action: () => window.location.href = `/settings`,
    },
    {
      id: "refresh-files",
      label: "Refresh Files",
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
      action: () => {
        const event = new CustomEvent("refresh-files");
        window.dispatchEvent(event);
      },
    },
    {
      id: "new-file",
      label: "Create New File",
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>,
      action: () => {
        const event = new CustomEvent("new-file");
        window.dispatchEvent(event);
      },
    },
    {
      id: "preview",
      label: "Toggle Preview",
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>,
      action: () => {
        const event = new CustomEvent("toggle-preview");
        window.dispatchEvent(event);
      },
    },
  ];
}
