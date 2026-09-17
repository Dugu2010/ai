"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const router = useRouter();

  const fetchProjects = async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlug || !newName) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug, name: newName }),
      });
      if (!res.ok) throw new Error("Failed to create project");
      await fetchProjects();
      setNewSlug("");
      setNewName("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const deleteProject = async (id: string) => {
    if (!confirm("Delete this project and its VM?")) return;
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (res.ok) {
        await fetchProjects();
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold mb-8">DAI</h1>

        <form onSubmit={createProject} className="mb-8">
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="Project slug"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
            />
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Project name"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
            />
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </form>

        {loading ? (
          <p>Loading...</p>
        ) : projects.length === 0 ? (
          <p className="text-gray-400">No projects yet. Create one above.</p>
        ) : (
          <div className="space-y-4">
            {projects.map((p) => (
              <div key={p.id} className="p-4 bg-gray-800 rounded border border-gray-700">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-semibold">{p.name}</h3>
                    <p className="text-sm text-gray-400">{p.slug}</p>
                    <p className="text-sm text-gray-500 mt-1">Status: {p.status}</p>
                    {p.previewUrl && (
                      <a
                        href={p.previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-400 hover:underline"
                      >
                        Preview
                      </a>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => router.push(`/projects/${p.id}`)}
                      className="px-3 py-1 bg-blue-600 rounded hover:bg-blue-700"
                    >
                      Open
                    </button>
                    <button
                      onClick={() => deleteProject(p.id)}
                      className="px-3 py-1 bg-red-600 rounded hover:bg-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
