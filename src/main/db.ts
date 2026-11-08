// SpacetimeDB client connection shared by the watcher, the agent and the UI bridge.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DbConnection } from '../module_bindings/index.js';
import { config } from './config.js';

export type Conn = DbConnection;

export const micros = (t: { microsSinceUnixEpoch: bigint } | undefined | null) =>
  t ? Number(t.microsSinceUnixEpoch / 1000n) : 0;

export function connect(tokenFile: string, onReady: (conn: Conn) => void, onStatus: (s: string) => void): Conn {
  let token: string | undefined;
  try {
    if (existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim() || undefined;
  } catch {
    /* ignore */
  }
  const conn = DbConnection.builder()
    .withUri(config.stdbUri)
    .withDatabaseName(config.stdbDatabase)
    .withToken(token)
    .onConnect((c, _identity, newToken) => {
      try {
        mkdirSync(dirname(tokenFile), { recursive: true });
        writeFileSync(tokenFile, newToken);
      } catch {
        /* ignore */
      }
      onStatus('connected');
      c.subscriptionBuilder()
        .onApplied(() => onReady(c))
        .onError((ctx) => onStatus(`subscription error: ${String((ctx as any)?.event ?? '')}`))
        .subscribeToAllTables();
    })
    .onConnectError((_ctx, err) => onStatus(`cannot reach SpacetimeDB at ${config.stdbUri} (${err.message}). Is "spacetime start" running and the module published?`))
    .onDisconnect((_ctx, err) => onStatus(`disconnected${err ? ': ' + err.message : ''}`))
    .build();
  return conn;
}

// Current session owned by this client (the newest active one).
export function activeSession(conn: Conn) {
  const me = conn.identity;
  let best: ReturnType<typeof allSessions>[number] | undefined;
  for (const s of allSessions(conn)) {
    if (me && !s.owner.isEqual(me)) continue;
    if (s.status !== 'active') continue;
    if (!best || s.id > best.id) best = s;
  }
  return best;
}

export function latestSession(conn: Conn) {
  const me = conn.identity;
  let best: ReturnType<typeof allSessions>[number] | undefined;
  for (const s of allSessions(conn)) {
    if (me && !s.owner.isEqual(me)) continue;
    if (!best || s.id > best.id) best = s;
  }
  return best;
}

function allSessions(conn: Conn) {
  return [...conn.db.session.iter()];
}

export function sessionEvents(conn: Conn, sessionId: bigint) {
  return [...conn.db.activityEvent.iter()].filter((e) => e.sessionId === sessionId).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function sessionInterventions(conn: Conn, sessionId: bigint) {
  return [...conn.db.intervention.iter()].filter((i) => i.sessionId === sessionId).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function sessionRules(conn: Conn, sessionId: bigint) {
  return [...conn.db.relevanceRule.iter()].filter((r) => r.sessionId === sessionId);
}

export function openIntervention(conn: Conn, sessionId: bigint) {
  return sessionInterventions(conn, sessionId).find((i) => i.resolvedAt === undefined);
}
