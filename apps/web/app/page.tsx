"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { isAuthenticated, fetchApi, logout } from "../lib/api-client";
import { PageSkeleton, ProjectSkeleton } from "../components/loading-skeleton";

interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  previewUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export default function HomePage() {
  const router = useRouter();
  const pathname = usePathname();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!isAuthenticated() && pathname !== "/auth/login") {
      router.replace("/auth/login");
    } else {
      setAuthLoading(false);
    }
  }, [router, pathname]);

  const fetchProjects = async () => {
    setError("");
    try {
      const res = await fetchApi("/api/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
      } else {
        const err = await res.json();
        setError(err.error || "Failed to fetch projects");
      }
    } catch {
      setError("Failed to fetch projects");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlug || !newName) return;
    setCreating(true);
    setError("");
    try {
      const res = await fetchApi("/api/projects", {
        method: "POST",
        body: JSON.stringify({ slug: newSlug, name: newName }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create project");
      }
      await fetchProjects();
      setNewSlug("");
      setNewName("");
      setShowModal(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this project and its VM?")) return;
    setError("");
    try {
      const res = await fetchApi(`/api/projects/${id}`, { method: "DELETE" });
      if (res.ok) {
        await fetchProjects();
      } else {
        const err = await res.json();
        setError(err.error || "Failed to delete project");
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      router.push("/auth/login");
    } catch {
      router.push("/auth/login");
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "ready":
        return "bg-green-500";
      case "creating":
        return "bg-yellow-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  if (authLoading) {
    return <PageSkeleton />;
  }

  return (
    <div className="min-h-screen bg-primary text-primary">
      <header className="border-b border-border bg-primary/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-accent-primary rounded-lg flex items-center justify-center">
                  <span className="font-bold text-white">D</span>
                </div>
                <h1 className="text-2xl font-bold">DAI</h1>
              </div>
              <nav className="hidden md:flex gap-4">
                <a href="/" className="text-accent-primary font-medium">Dashboard</a>
                <a href="/settings" className="text-secondary hover:text-primary">Settings</a>
              </nav>
            </div>
             <div className="flex items-center gap-4">
                <div className="hidden md:flex items-center gap-2 text-secondary">
                  <span className="text-sm">Projects:</span>
                  <span className="text-accent-primary font-semibold">{projects.length}</span>
                </div>
                <button
                  onClick={() => setShowModal(true)}
                  className="hidden md:block px-4 py-2 bg-accent-primary rounded-lg hover:bg-accent-hover text-sm font-medium"
                >
                  New Project
                </button>
                <button
                  onClick={handleLogout}
                  className="text-secondary hover:text-primary text-sm font-medium"
                >
                  Logout
                </button>
                <button
                  onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                  className="md:hidden text-secondary"
                  aria-label="Toggle menu"
                >
                  ☰
                </button>
              </div>
          </div>
           {mobileMenuOpen && (
             <div className="md:hidden mt-4 flex flex-col gap-2">
               <a href="/" className="px-4 py-2 bg-secondary rounded text-accent-primary font-medium">Dashboard</a>
               <a href="/settings" className="px-4 py-2 bg-secondary rounded">Settings</a>
               <button
                 onClick={() => { setShowModal(true); setMobileMenuOpen(false); }}
                 className="px-4 py-2 bg-accent-primary rounded text-left text-white font-medium"
               >
                 New Project
               </button>
             </div>
           )}
         </div>
       </header>

        <main className="max-w-7xl mx-auto px-4 md:px-6 py-8">
        <div className="mb-8 flex justify-between items-center">
          <div>
            <h2 className="text-3xl font-bold mb-2">Projects</h2>              <p className="text-secondary">Manage your DAI projects</p>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="md:hidden px-4 py-2 bg-accent-primary rounded-lg text-white text-sm font-medium"
          >
            + New
          </button>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <ProjectSkeleton />
            <ProjectSkeleton />
            <ProjectSkeleton />
            <ProjectSkeleton />
            <ProjectSkeleton />
            <ProjectSkeleton />
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-16 bg-secondary/50 rounded-lg border border-border">
            <div className="w-16 h-16 bg-tertiary rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">📁</span>
            </div>
            <h3 className="text-xl font-semibold mb-2">No projects yet</h3>
            <p className="text-secondary mb-6 max-w-md mx-auto">Create your first project to get started</p>
            <button
              onClick={() => setShowModal(true)}
              className="px-6 py-3 bg-accent-primary text-white rounded-lg hover:bg-accent-hover font-medium transition-all hover:shadow-md"
            >
              Create Your First Project
            </button>
          </div>
        ) : (
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
             {projects.map((p) => (
               <div
                 key={p.id}
                 className="p-6 bg-secondary rounded-lg border border-border hover:border-accent-primary transition-all hover:shadow-lg flex flex-col"
               >
                 <div className="flex items-start justify-between mb-4">
                   <div className="flex items-center gap-2">
                     <div className={`w-2 h-2 rounded-full ${getStatusColor(p.status)}`} aria-label={`Status: ${p.status}`} />
                     <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${
                       p.status === 'ready' ? 'bg-green-500/10 text-green-500' :
                       p.status === 'creating' ? 'bg-yellow-500/10 text-yellow-500' :
                       p.status === 'error' ? 'bg-red-500/10 text-red-500' :
                       'bg-gray-500/10 text-gray-500'
                     }`}>{p.status}</span>
                   </div>
                     <div className="text-xs text-muted">
                     {formatDate(p.updatedAt || p.createdAt)}
                   </div>
                 </div>
                 <h3 className="font-semibold text-lg mb-1">{p.name}</h3>
                  <p className="text-sm text-muted mb-4 font-mono">{p.slug}</p>
                 {p.previewUrl && (
                   <a
                     href={p.previewUrl}
                     target="_blank"
                     rel="noopener noreferrer"
                     className="text-sm text-accent-primary hover:underline mb-4 inline-block"
                   >
                     Preview →
                   </a>
                 )}
                 <div className="mt-auto flex gap-2">
                   <button
                     onClick={() => router.push(`/projects/${p.id}`)}
                     title="Open project"
                     className="flex-1 px-3 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-hover text-sm font-medium transition-all"
                   >
                     Open
                   </button>
                   <button
                     onClick={() => handleDelete(p.id)}
                     title="Delete project"
                     className="px-3 py-2 bg-red-600/10 text-red-500 rounded-lg hover:bg-red-600/20 text-sm font-medium transition-all"
                   >
                     Delete
                   </button>
                 </div>
               </div>
             ))}
           </div>
        )}

          {error && (
            <div className="mt-6 p-4 bg-red-600/10 border border-red-600/30 rounded-lg flex items-center justify-between">
              <span className="text-red-500">{error}</span>
              <button
                onClick={fetchProjects}
                className="px-4 py-2 bg-red-600/10 text-red-500 rounded-lg hover:bg-red-600/20 text-sm font-medium transition-all"
              >
                Retry
              </button>
            </div>
          )}
       </main>

      {showModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setShowModal(false)}
        >
           <div
             className="bg-secondary p-6 rounded-lg w-full max-w-md border border-[color:var(--border-color)]"
             onClick={(e) => e.stopPropagation()}
           >
             <h2 className="text-xl font-bold mb-4">Create New Project</h2>
             <form onSubmit={handleCreate}>
               <div className="mb-4">
                 <label className="block text-secondary text-sm font-medium mb-2">
                   Slug
                 </label>
                 <input
                   type="text"
                   value={newSlug}
                   onChange={(e) => setNewSlug(e.target.value)}
                   placeholder="my-project"
                   className="w-full px-4 py-2 bg-tertiary border border-[color:var(--border-color)] rounded-lg focus:outline-none focus:border-[color:var(--accent-primary)]"
                  autoFocus
                />
              </div>
               <div className="mb-6">
                 <label className="block text-secondary text-sm font-medium mb-2">
                   Name
                 </label>
                 <input
                   type="text"
                   value={newName}
                   onChange={(e) => setNewName(e.target.value)}
                   placeholder="My Project"
                   className="w-full px-4 py-2 bg-tertiary border border-[color:var(--border-color)] rounded-lg focus:outline-none focus:border-[color:var(--accent-primary)]"
                 />
               </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 py-2 bg-accent-primary rounded-lg hover:bg-accent-hover disabled:opacity-50 font-medium"
                >
                  {creating ? "Creating..." : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                   className="px-4 py-2 bg-tertiary rounded-lg hover:bg-secondary font-medium"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

       <button
         onClick={() => setShowModal(true)}
         className="fixed bottom-6 right-6 w-14 h-14 bg-accent-primary rounded-full flex items-center justify-center hover:bg-accent-hover focus:outline-none focus:ring-4 focus:ring-accent-primary/30 shadow-lg z-40 touch-manipulation transition-all"
         aria-label="Create new project"
         style={{
           paddingBottom: 'env(safe-area-inset-bottom, 0)',
           paddingRight: 'env(safe-area-inset-right, 0)',
         }}
       >
         <span className="text-2xl font-bold">+</span>
       </button>
     </div>
  );
}
