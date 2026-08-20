export const WEB_PUSH_ROUTE_BASE = "/api/v1/plugins/notify/http/web-push";
export const SERVICE_WORKER_URL = `${WEB_PUSH_ROUTE_BASE}/service-worker.js`;
export const SERVICE_WORKER_SCOPE = `${WEB_PUSH_ROUTE_BASE}/`;

export const SERVICE_WORKER_SOURCE = String.raw`
const fallback = {
  title: 'bb',
  body: 'A BB notification arrived.',
  tag: 'bb-notify-push',
  url: '/',
  threadId: null,
  silent: false,
};

function pushPayload(event) {
  let value = null;
  try {
    value = event.data ? event.data.json() : null;
  } catch {}
  if (!value || typeof value !== 'object') return fallback;
  const url =
    typeof value.url === 'string' && value.url.startsWith('/') && !value.url.startsWith('//')
      ? value.url
      : '/';
  return {
    title: typeof value.title === 'string' && value.title ? value.title : fallback.title,
    body: typeof value.body === 'string' ? value.body : fallback.body,
    tag: typeof value.tag === 'string' && value.tag ? value.tag : fallback.tag,
    url,
    threadId: typeof value.threadId === 'string' ? value.threadId : null,
    silent: typeof value.silent === 'boolean' ? value.silent : fallback.silent,
  };
}

async function openThread(url, threadId) {
  const path =
    typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
  const target = new URL(path, self.location.origin);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const matching = windows.find((client) => {
    const current = new URL(client.url);
    return current.origin === target.origin && current.pathname === target.pathname;
  });
  if (matching) {
    try {
      return await matching.focus();
    } catch {}
  }

  const app = windows.find((client) => new URL(client.url).origin === target.origin);
  if (app) {
    try {
      await app.focus();
      app.postMessage({ type: 'bb-notify-open-thread', threadId, url: path });
      return;
    } catch {}
  }
  return self.clients.openWindow(target.href);
}

self.addEventListener('push', (event) => {
  const payload = pushPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      renotify: true,
      silent: payload.silent,
      data: { url: payload.url, threadId: payload.threadId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const threadId = data && typeof data.threadId === 'string' ? data.threadId : null;
  const url = data && typeof data.url === 'string' ? data.url : '/';
  event.waitUntil(openThread(url, threadId));
});
`;
