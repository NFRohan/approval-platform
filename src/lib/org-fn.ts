// =====================================================================
// The organisation's own name, for documents that carry it — the
// clearance certificate, as the payment top sheet already does. The
// template and test organisations read as the portal instead.
// =====================================================================

import { createServerFn } from '@tanstack/react-start';
import { getPool, resolveContext } from '@/server/db';

export const organisationName = createServerFn({ method: 'GET' })
  .handler(async (): Promise<string> => {
    try {
      const ctx = await resolveContext();
      if (!ctx.tenantId) return 'Admin Services Portal';
      const { rows: [t] } = await getPool().query('select name from public.tenants where id = $1', [ctx.tenantId]);
      const name = (t?.name as string | undefined)?.trim();
      return name && !/^(template|local qa)$/i.test(name) ? name : 'Admin Services Portal';
    } catch {
      return 'Admin Services Portal';
    }
  });
