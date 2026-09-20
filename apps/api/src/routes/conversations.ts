import { Router, Request, Response } from "express";
import { getActiveConversation, createConversation, getProjectByUser, listMessages, query } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { NIM_MODEL } from "../lib/env.js";
import { MAX_REQUEST_BODY_SIZE } from "../lib/validation.js";

const router = Router();
router.use(requireAuth);

router.get("/:projectId", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.projectId!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const conv = await getActiveConversation(project.id);
    res.json(conv);
  } catch (error: any) {
    console.error("[conversations:GET]", error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get("/:conversationId/messages", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    // Verify conversation belongs to user via project_id join.
    const conv = await query<{ project_id: string }>(
      "SELECT project_id FROM conversations WHERE id = $1",
      [req.params.conversationId!]
    );
    if (!conv.rows[0]) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const project = await getProjectByUser(conv.rows[0].project_id, user.userId);
    if (!project) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const msgs = await listMessages(req.params.conversationId!);
    res.json(msgs);
  } catch (error: any) {
    console.error("[conversations:messages:GET]", error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post("/:projectId", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.projectId!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      res.status(413).json({ error: "Request body exceeds maximum size" });
      return;
    }
    const { title, model } = req.body ?? {};
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title required" });
      return;
    }
    const conv = await createConversation(project.id, {
      title,
      model: typeof model === "string" && model ? model : NIM_MODEL(),
    });
    res.status(201).json(conv);
  } catch (error: any) {
    console.error("[conversations:POST]", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
