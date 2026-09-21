/**
 * Executed by `restoreFiles` inside the Sandbox with python3 (installed in the
 * DAI runtime image). Arguments arrive as one base64 JSON blob, so no file
 * content or path is ever interpolated into a shell string.
 *
 * Per entry it verifies the file still holds the content the checkpoint says we
 * left behind, and reports a conflict instead of overwriting anything it does
 * not own. That is what keeps undo from destroying unrelated edits.
 */
export const RESTORE_SCRIPT = `
import base64, json, os, sys

WORKSPACE = "/workspace/"
payload = sys.argv[-1]
entries = json.loads(base64.b64decode(payload).decode("utf-8"))
results = []

for entry in entries:
    path = entry["path"]
    content = entry["content"]
    expect = entry["expectCurrent"]

    if not path.startswith(WORKSPACE):
        results.append({"path": path, "status": "skipped",
                        "detail": "path is outside the project workspace"})
        continue

    try:
        current = None
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                current = handle.read()

        if expect is None:
            if current is not None:
                results.append({"path": path, "status": "conflict",
                                "detail": "file exists but the checkpoint recorded it as absent"})
                continue
        else:
            if current is None:
                results.append({"path": path, "status": "conflict",
                                "detail": "file no longer exists"})
                continue
            if current != expect:
                results.append({"path": path, "status": "conflict",
                                "detail": "content changed since the checkpoint"})
                continue

        if content is None:
            if current is not None:
                os.remove(path)
            results.append({"path": path, "status": "deleted"})
        else:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(content)
            results.append({"path": path, "status": "restored"})
    except Exception as exc:
        results.append({"path": path, "status": "error", "detail": str(exc)})

sys.stdout.write("DAI_RESTORE_RESULT" + json.dumps(results))
`;

/** Marker the script writes immediately before its JSON result array. */
export const RESTORE_MARKER = "DAI_RESTORE_RESULT";
