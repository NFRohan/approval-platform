import { Paperclip } from "lucide-react";
import type { AttachmentInfo } from "@/lib/attachment-fn";

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A file attached to a submission, as a download.
 *
 * A plain anchor, not a router Link: the file is a server response to be
 * saved, not a screen to navigate to.
 */
export function AttachmentLink({ file }: { file: AttachmentInfo }) {
  return (
    <a
      href={`/files/${file.id}`}
      download={file.file_name}
      className="inline-flex items-center gap-1.5 rounded-md"
      style={{
        padding: "3px 8px",
        fontSize: 12.5,
        color: "#4338CA",
        background: "#EEF2FF",
        border: "1px solid #E0E7FF",
        textDecoration: "none",
        maxWidth: "100%",
      }}
    >
      <Paperclip size={12} style={{ flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.file_name}</span>
      <span style={{ color: "#6366F1", flexShrink: 0 }}>· {size(file.size_bytes)}</span>
    </a>
  );
}
