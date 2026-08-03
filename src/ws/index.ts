import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

/**
 * WebSocket 事件推送（需求文档 FR-8 看板）。
 * 任何事件落库后同时广播；客户端可带 lastEventId 做断线重放。
 */

let wss: WebSocketServer | null = null;

export function initWs(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // 可选：从 query 恢复断线前的游标（浏览器 WS 用 lastEventId 约定）
    const url = new URL(req.url ?? '/', 'http://localhost');
    const since = url.searchParams.get('since');
    ws.on('error', () => {});
    if (since) {
      // 断线重放：让客户端自己去拉 /api/events?since=，这里只发提示
      ws.send(JSON.stringify({ type: 'resume', since }));
    }
    ws.send(JSON.stringify({ type: 'hello', now: new Date().toISOString() }));
  });
  return wss;
}

export function stopWs(server: WebSocketServer | null): void {
  if (server) {
    for (const client of server.clients) client.close();
    server.close();
  }
  wss = null;
}

export function broadcast(message: string): void {
  if (!wss) return;
  const data = Buffer.from(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

export function getWss(): WebSocketServer | null {
  return wss;
}
