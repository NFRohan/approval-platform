// A sample NFA with two business cases, as a Word document, so filling a
// form from Word can be shown without one to hand: /samples/campaign-nfa
import { createFileRoute } from "@tanstack/react-router";
import { sampleNfaDocx } from "@/server/docx";

export const Route = createFileRoute("/samples/campaign-nfa")({
  server: {
    handlers: {
      GET: async () => new Response(new Uint8Array(sampleNfaDocx()), {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-disposition": 'attachment; filename="sample-campaign-nfa.docx"',
          "cache-control": "no-store",
        },
      }),
    },
  },
});
