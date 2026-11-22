import { Paperclip } from "lucide-react";
import type { AttachmentInfo } from "@/lib/attachment-fn";
import { useCurrentUser } from "@/contexts/CurrentUserContext";

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A file attached to a submission, as a download.
 *
 * A plain anchor, not a router Link: the file is a server response to be
 * saved, not a screen to navigate to. It names who is opening it, for the
 * document access log.
 */
export function AttachmentLink({ file }: { file: AttachmentInfo }) {
  const { currentUser } = useCurrentUser();
  return (
    <a
      href={`/files/${file.id}?by=${encodeURIComponent(currentUser.employee_id)}`}
      download={file.file_name}
      className="inline-flex items-center gap-1.5 rounded-md"
      style={{
        padding: "3px 8px",
        fontSize: 12.5,
        color: file.superseded_at ? "#71717A" : "#4338CA",
        background: file.superseded_at ? "#F4F4F5" : "#EEF2FF",
        border: `1px solid ${file.superseded_at ? "#E4E4E7" : "#E0E7FF"}`,
        textDecoration: "none",
        maxWidth: "100%",
      }}
    >
      <Paperclip size={12} style={{ flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.file_name}</span>
      <span style={{ flexShrink: 0, opacity: 0.8 }}>
        · {size(file.size_bytes)}{file.version > 1 || file.superseded_at ? ` · v${file.version}` : ""}
      </span>
    </a>
  );
}
