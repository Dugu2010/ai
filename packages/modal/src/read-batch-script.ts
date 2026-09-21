/**
 * Batched read used to capture undo pre-images.
 *
 * Undo needs the bytes that exist *before* a write. Fetching them one file at a
 * time would cost one Sandbox command per file, so all pending paths are read in
 * a single request instead. Contents come back base64 so arbitrary text survives
 * transport unchanged.
 */
export const READ_BATCH_SCRIPT = `
import base64, json, os, sys

WORKSPACE = "/workspace/"
paths = json.loads(base64.b64decode(sys.argv[-1]).decode("utf-8"))
out = {}

for path in paths:
    if not path.startswith(WORKSPACE):
        out[path] = {"error": "outside workspace"}
        continue
    if not os.path.isfile(path):
        out[path] = {"exists": False}
        continue
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            data = handle.read()
        out[path] = {
            "exists": True,
            "size": size,
            "encoding": "base64",
            "data": base64.b64encode(data).decode("ascii"),
        }
    except Exception as exc:
        out[path] = {"error": str(exc)}

sys.stdout.write("DAI_READ_RESULT" + base64.b64encode(json.dumps(out).encode("utf-8")).decode("ascii"))
`;

export const READ_BATCH_MARKER = "DAI_READ_RESULT";
