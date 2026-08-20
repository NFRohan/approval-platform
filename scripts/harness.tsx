// Loaded through Vite so that the router, the provider and the routes all
// come from ONE module graph. Loading them separately gave the provider
// and the components different instances of the router module, and the
// context lookup then found nothing.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { getRouter } from '@/router';

export async function renderPath(path: string): Promise<string> {
  const router = getRouter();
  // getRouter leaves history to the framework, which supplies one per
  // request. Supply one here.
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
}
