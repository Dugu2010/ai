"use client";

/**
 * Project workspace.
 *
 * The page is declarative on purpose: two hooks own all I/O — `useAgentRun`
 * (activity stream, `/status`, run controls, checkpoints, undo/redo) and
 * `useWorkspace` (project, runtime state, files, editor, preview) — and every
 * visible thing is a panel fed by them.
 *
 * Layout
 *   ≥ lg   explorer | editor | activity over chat, with a full-width strip below
 *   < lg   one pane at a time, four destinations in the bottom bar, and the
 *          explorer / preview / details as focus-trapped overlays
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  Eye,
  FolderOpen,
  History,
  Info,
  RefreshCw,
  Settings,
  Square,
} from "lucide-react";
import { modelLabel } from "@/lib/format";
import { isAuthenticated } from "@/lib/api-client";
import { useAuthenticated } from "@/lib/use-auth";
import { useMediaQuery, NARROW_QUERY, WIDE_QUERY } from "@/lib/use-media-query";
import { useAgentRun } from "@/lib/use-agent-run";
import { useWorkspace } from "@/lib/use-workspace";
import { pillForRun } from "@/components/status-pill";
import { CommandPalette } from "@/components/command-palette";
import { ActivityTimeline } from "@/components/activity-timeline";
import { BudgetMeter } from "@/components/budget-meter";
import { ChangesPanel } from "@/components/changes-panel";
import { ChatPanel } from "@/components/chat-panel";
import { EditorPane } from "@/components/editor-pane";
import { FileTree } from "@/components/file-tree";
import { MobileNav, type MobilePane } from "@/components/mobile-nav";
import { NoticeBar } from "@/components/panel";
import { PreviewPanel } from "@/components/preview-panel";
import { RunControls } from "@/components/run-controls";
import { RuntimePanel, StatusPanel } from "@/components/runtime-panel";
import { Drawer, Sheet } from "@/components/sheet";
import { WorkspaceStrip, type StripTab } from "@/components/workspace-strip";
import { WorkspaceTopbar } from "@/components/workspace-topbar";
import { useToast } from "@/components/toast";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default function ProjectWorkspacePage() {
  const router = useRouter();
  const params = useParams<{ id?: string | string[] }>();
  const projectId = firstParam(params?.id);
  const { showToast } = useToast();

  const authed = useAuthenticated();
  const isWide = useMediaQuery(WIDE_QUERY);
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const enabled = authed && Boolean(projectId);

  const [stripTab, setStripTab] = useState<StripTab>("changes");
  const [stripExpanded, setStripExpanded] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const [filesOpen, setFilesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const workspace = useWorkspace(projectId, enabled);
  const refreshTree = workspace.refreshTree;
  const refreshStatus = workspace.refreshStatus;
  const reportPreviewUrl = workspace.reportPreviewUrl;
  const selectFile = workspace.selectFile;

  const onWorkspaceChanged = useCallback(async () => {
    await Promise.all([refreshTree(), refreshStatus()]);
  }, [refreshTree, refreshStatus]);

  const onPreviewUrl = useCallback((url: string) => reportPreviewUrl(url), [reportPreviewUrl]);

  const notice = useCallback(
    (message: string, tone: "error" | "success" | "info") => showToast(message, tone),
    [showToast]
  );

  const agent = useAgentRun({ projectId, enabled, onWorkspaceChanged, onPreviewUrl, onNotice: notice });

  /* ---- Cross-panel navigation -------------------------------------------- */

  const openChanges = useCallback(() => {
    if (isWide) {
      setStripTab("changes");
      setStripExpanded(true);
      return;
    }
    setMobilePane("changes");
  }, [isWide]);

  const openPreview = useCallback(() => {
    if (isWide) {
      setStripTab("preview");
      setStripExpanded(true);
      return;
    }
    setPreviewOpen(true);
  }, [isWide]);

  const openFiles = useCallback(() => {
    if (isWide) {
      // The explorer is docked on desktop; this action re-reads it instead.
      void refreshTree();
      return;
    }
    setFilesOpen(true);
  }, [isWide, refreshTree]);

  const openFile = useCallback(
    (path: string) => {
      setFilesOpen(false);
      if (!isWide) setMobilePane("code");
      void selectFile(path);
    },
    [isWide, selectFile]
  );

  const openDetails = useCallback(() => {
    if (isWide) {
      setStripTab("status");
      setStripExpanded(true);
      return;
    }
    setDetailsOpen(true);
  }, [isWide]);

  useEffect(() => {
    if (authed || typeof window === "undefined") return;
    if (!isAuthenticated()) router.replace("/auth/login");
  }, [authed, router]);

  /* ---- View model -------------------------------------------------------- */

  const pill = pillForRun(agent.run, agent.live, agent.streaming);
  const previewRunning = Boolean(workspace.status?.devServerRunning);
  const model = agent.modelId;
  const statusLine = agent.agentError ?? agent.statusError;

  const runControls = (
    <RunControls
      flags={agent.flags}
      live={agent.live}
      streaming={agent.streaming}
      hasRun={Boolean(agent.run)}
      pauseChoices={agent.facts.pauseChoices}
      onContinue={() => void agent.continueRun()}
      onRetryDifferently={() => void agent.retryDifferently()}
      onStop={() => void agent.stop()}
      onUndo={agent.flags.canUndo ? openChanges : undefined}
    />
  );

  const budget = (
    <BudgetMeter
      run={agent.run}
      limits={agent.limits}
      loading={agent.statusLoading}
      exhausted={agent.run?.outcome === "budget_exhausted"}
    />
  );

  const timeline = (
    <ActivityTimeline
      events={agent.events}
      run={agent.run}
      facts={agent.facts}
      elapsed={agent.elapsed}
      live={agent.live}
      loading={agent.statusLoading}
      error={statusLine}
      onDismissError={agent.dismissError}
      budget={budget}
      controls={runControls}
      onOpenPreview={openPreview}
      hasPreview={Boolean(workspace.previewUrl)}
    />
  );

  const chat = (
    <ChatPanel
      messages={agent.messages}
      streaming={agent.streaming}
      loading={agent.statusLoading}
      modelLabel={model ? modelLabel(model) : ""}
      onSend={(text) => void agent.send(text)}
      // On a phone the activity pane is a tab away, so the run controls are
      // repeated here — never both on screen at once.
      banner={!isWide && agent.live ? runControls : undefined}
    />
  );

  const changes = (
    <ChangesPanel
      checkpoints={agent.checkpoints}
      flags={agent.flags}
      restore={agent.restore}
      restoreBusy={agent.restoreBusy}
      changedPathsByCheckpoint={agent.changedPathsByCheckpoint}
      checkpointFiles={agent.checkpointFiles}
      checkpointDetailBusy={agent.checkpointDetailBusy}
      checkpointDetailError={agent.checkpointDetailError}
      onExpandCheckpoint={(id) => void agent.loadCheckpointDetail(id)}
      loading={agent.checkpointsLoading}
      error={agent.checkpointsError}
      onUndo={() => void agent.undo()}
      onRedo={() => void agent.redo()}
      onClearRestore={agent.clearRestore}
      onOpenFile={openFile}
    />
  );

  const editor = (
    <EditorPane
      path={workspace.selectedFile}
      value={workspace.fileContent}
      size={workspace.selectedSize}
      loading={workspace.fileLoading}
      error={workspace.fileError}
      dirty={workspace.dirty}
      readOnly={isNarrow}
      onChange={workspace.changeFile}
      onSave={() => void workspace.saveFile()}
      onDismissError={workspace.clearFileError}
      onClose={workspace.closeFile}
    />
  );

  const preview = (
    <PreviewPanel
      url={workspace.previewUrl}
      running={previewRunning}
      busy={workspace.previewBusy}
      error={workspace.previewError}
      runtimeReady={workspace.runtimeReady}
      onStart={() => void workspace.startPreview()}
      onStop={() => void workspace.stopPreview()}
      onDismissError={workspace.clearPreviewError}
    />
  );

  const runtime = (
    <RuntimePanel
      status={workspace.status}
      run={agent.run}
      limits={agent.limits}
      budgetLoading={agent.statusLoading}
      runtimeBusy={workspace.runtimeBusy}
      model={model}
      onRestart={() => void workspace.restartRuntime()}
    />
  );

  const statusPanel = (
    <StatusPanel
      project={workspace.project}
      status={workspace.status}
      run={agent.run}
      checkpointCount={agent.checkpoints.length}
      eventCount={agent.events.length}
      elapsed={agent.elapsed}
      error={agent.checkpointsError}
    />
  );

  const tree = (
    <FileTree
      entries={workspace.entries}
      loading={workspace.dirLoading}
      selectedFile={workspace.selectedFile}
      changedPaths={agent.facts.filesChanged}
      error={workspace.treeError}
      loadingRoot={workspace.projectLoading || workspace.rootLoading}
      runtimeReady={workspace.runtimeReady}
      onSelect={openFile}
      onLoadDir={(path) => void workspace.loadDir(path)}
      onRetry={() => void workspace.refreshTree()}
    />
  );

  // A short list rebuilt per render: cheap, and it keeps the palette's commands
  // truthful about what is currently possible.
  const paletteCommands = (() => {
    const items = [
      { id: "changes", label: "Show changes and undo", icon: <History size={14} aria-hidden="true" />, action: openChanges },
      { id: "preview", label: "Show preview", icon: <Eye size={14} aria-hidden="true" />, action: openPreview },
      { id: "files", label: isWide ? "Re-read file list" : "Open file explorer", icon: <FolderOpen size={14} aria-hidden="true" />, action: openFiles },
      { id: "details", label: "Runtime and status", icon: <Info size={14} aria-hidden="true" />, action: openDetails },
      { id: "settings", label: "Open settings", icon: <Settings size={14} aria-hidden="true" />, action: () => router.push("/settings") },
      { id: "projects", label: "Back to projects", icon: <ArrowLeft size={14} aria-hidden="true" />, action: () => router.push("/app/projects") },
    ];
    if (agent.live && agent.run) {
      items.push({ id: "stop", label: "Stop this run", icon: <Square size={13} aria-hidden="true" />, action: () => void agent.stop() });
    }
    if (agent.flags.canContinue) {
      items.push({ id: "continue", label: "Continue the run", icon: <ActivityIcon size={14} aria-hidden="true" />, action: () => void agent.continueRun() });
    }
    if (agent.flags.canRetryDifferently) {
      items.push({ id: "retry", label: "Retry differently", icon: <RefreshCw size={14} aria-hidden="true" />, action: () => void agent.retryDifferently() });
    }
    return items;
  })();

  /* ---- Boot states ------------------------------------------------------- */

  if (!projectId) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-6" style={{ background: "var(--bg-canvas)" }}>
        <div className="w-full max-w-md">
          <NoticeBar tone="danger" message="This workspace address is missing its project id." />
          <button type="button" onClick={() => router.push("/app/projects")} className="btn btn-secondary w-full mt-3">
            Back to projects
          </button>
        </div>
      </div>
    );
  }

  if (!authed) {
    return <WorkspaceSkeleton />;
  }

  if (workspace.projectError && !workspace.project) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-6" style={{ background: "var(--bg-canvas)" }}>
        <div className="w-full max-w-md space-y-3">
          <h1 className="text-[18px]" style={{ fontWeight: 590 }}>
            Project unavailable
          </h1>
          <NoticeBar tone="danger" message={workspace.projectError} />
          <div className="flex gap-2">
            <button type="button" onClick={() => void workspace.reloadProject()} className="btn btn-primary flex-1">
              Try again
            </button>
            <button type="button" onClick={() => router.push("/app/projects")} className="btn btn-secondary flex-1">
              Back to projects
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden" style={{ background: "var(--bg-canvas)" }}>
      <CommandPalette commands={paletteCommands} />

      <WorkspaceTopbar
        projectName={workspace.project?.name ?? "Project"}
        projectSlug={workspace.project?.slug ?? ""}
        pill={pill}
        elapsed={agent.elapsed}
        meta={
          <span
            className="hidden lg:inline font-mono text-[11px] truncate max-w-[16ch]"
            style={{ color: "var(--text-muted)" }}
            title={`Model for this conversation: ${model}`}
          >
            {modelLabel(model)}
          </span>
        }
        previewRunning={previewRunning}
        wide={isWide}
        onOpenFiles={() => setFilesOpen(true)}
        onOpenPreview={openPreview}
        onOpenDetails={openDetails}
      />

      <div id="main-content" tabIndex={-1} className="flex-1 min-h-0 flex flex-col outline-none">
        {workspace.projectError ? (
          <div className="p-2 shrink-0">
            <NoticeBar
              tone="danger"
              message={workspace.projectError}
              action={
                <button
                  type="button"
                  onClick={() => void workspace.reloadProject()}
                  className="btn btn-ghost px-2 text-[12px]"
                >
                  Retry
                </button>
              }
            />
          </div>
        ) : null}

        {isWide ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex">
              <aside
                className="w-[230px] xl:w-[262px] shrink-0 border-r min-h-0 flex"
                style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
                aria-label="Explorer"
              >
                {tree}
              </aside>
              <main
                className="flex-1 min-w-0 flex flex-col min-h-0 border-r"
                style={{ borderColor: "var(--border-color)" }}
              >
                {editor}
              </main>
              <aside
                className="w-[390px] xl:w-[460px] shrink-0 border-l flex flex-col min-h-0"
                style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
                aria-label="Agent"
              >
                <div className="flex-1 min-h-0 flex flex-col">{timeline}</div>
                <div
                  className="h-[42%] min-h-[200px] shrink-0 flex flex-col border-t"
                  style={{ borderColor: "var(--border-color)" }}
                >
                  {chat}
                </div>
              </aside>
            </div>

            <WorkspaceStrip
              tab={stripTab}
              onTabChange={setStripTab}
              expanded={stripExpanded}
              onToggleExpanded={() => setStripExpanded((prev) => !prev)}
              badges={{
                changes: agent.checkpoints.length > 0 ? String(agent.checkpoints.length) : null,
                preview: previewRunning ? "live" : null,
              }}
            >
              <div className="h-full w-full max-w-[1500px] mx-auto overflow-hidden">
                {stripTab === "changes" ? changes : null}
                {stripTab === "runtime" ? <div className="h-full overflow-y-auto">{runtime}</div> : null}
                {stripTab === "preview" ? preview : null}
                {stripTab === "status" ? <div className="h-full overflow-y-auto">{statusPanel}</div> : null}
              </div>
            </WorkspaceStrip>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col">
              {mobilePane === "chat" ? chat : null}
              {mobilePane === "activity" ? timeline : null}
              {mobilePane === "code" ? editor : null}
              {mobilePane === "changes" ? changes : null}
            </div>
            <MobileNav
              active={mobilePane}
              onChange={setMobilePane}
              attention={{ activity: agent.live, changes: agent.flags.canUndo }}
            />
          </div>
        )}
      </div>

      <Drawer open={filesOpen} title="Files" onClose={() => setFilesOpen(false)}>
        {tree}
      </Drawer>
      <Sheet open={previewOpen} title="Preview" onClose={() => setPreviewOpen(false)}>
        {preview}
      </Sheet>
      <Sheet open={detailsOpen} title="Runtime and status" onClose={() => setDetailsOpen(false)}>
        <div className="h-full overflow-y-auto">
          <div style={{ minHeight: 320 }}>{runtime}</div>
          <div style={{ minHeight: 320, borderTop: "1px solid var(--border-color)" }}>{statusPanel}</div>
        </div>
      </Sheet>
    </div>
  );
}

/** The workspace's own loading shape — panels, not a blocking spinner. */
function WorkspaceSkeleton() {
  return (
    <div className="h-[100dvh] flex flex-col" style={{ background: "var(--bg-canvas)" }} aria-busy="true">
      <div className="flex items-center gap-3 px-3 h-12 border-b" style={{ borderColor: "var(--border-color)" }}>
        <div className="skeleton" style={{ width: 140, height: 14 }} />
        <div className="skeleton" style={{ width: 72, height: 20, borderRadius: 999 }} />
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="hidden lg:flex w-[230px] shrink-0 flex-col gap-2 p-3 border-r" style={{ borderColor: "var(--border-color)" }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" style={{ height: 12, width: `${84 - i * 8}%` }} />
          ))}
        </div>
        <div className="flex-1 min-w-0 p-3">
          <div className="skeleton h-full" style={{ minHeight: 200, borderRadius: 8 }} />
        </div>
        <div className="hidden lg:flex w-[390px] shrink-0 flex-col gap-2 p-3 border-l" style={{ borderColor: "var(--border-color)" }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 40, width: "100%" }} />
          ))}
        </div>
      </div>
      <div className="h-11 border-t" style={{ borderColor: "var(--border-color)" }} />
    </div>
  );
}
