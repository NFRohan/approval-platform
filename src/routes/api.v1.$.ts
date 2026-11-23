// =====================================================================
// The open API, /api/v1/* — see src/server/api.ts, and /developers.
// =====================================================================

import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "@/server/api";

const handle = ({ request, params }: { request: Request; params: { _splat?: string } }) =>
  handleApi(request, params._splat ?? "");

export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
});
