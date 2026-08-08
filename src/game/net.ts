// NetClient — host-authoritative co-op over Supabase (wasteland-commons).
//
// Two lanes, deliberately separated by doctrine Part 6B's "never block the
// game loop on the network" rule:
//   FAST  — one Realtime broadcast channel per room (`room:{world_id}`) for
//           everything above 1 Hz: player transforms, host→guest entity
//           snapshots, one-shot events. Nothing here touches the DB.
//   SLOW  — PostgREST for the durable control plane: room row, player
//           sessions (roster), and the host lease (authority + failover).
// The rustfall_events / rustfall_commands tables are intentionally UNUSED in
// v1: broadcast covers every gameplay message, and no durable audit trail
// proved worth the write amplification. The room row itself (world_seed,
// protocol_version) is the only durable state a session needs.
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { PROTOCOL_VERSION, SUPABASE_ANON_KEY, SUPABASE_URL, WORLD_SEED } from "./netConfig";

export type NetRole = "HOST" | "GUEST";

export interface RosterEntry {
  id: string;
  name: string;
  host: boolean;
}

/** Player transform, broadcast at 10 Hz. Keys kept short — small payloads. */
export interface TransformMsg {
  id: string;
  n: string;
  p: [number, number, number];
  y: number; // body yaw
  c: number; // camera pitch
  m: string; // FOOT | VEHICLE | MECH
  w: string; // weapon id
  g: number; // planar speed m/s (drives the walk gait)
}

/** One hostile entity in a host snapshot: [id, x, y, z, yaw, hp, dead]. */
export type EntEntry = [string, number, number, number, number, number, number];

/** Host → guests, broadcast at 8 Hz. `c` = opened cache ids (self-heal). */
export interface EntSnapshotMsg {
  e: EntEntry[];
  c: string[];
}

/** One-shot event message on the "ev" broadcast lane. `k` is the kind. */
export interface EventMsg {
  k: string;
  [key: string]: unknown;
}

const PLAYER_ID_KEY = "rustfall.playerId";
const TOKEN_KEY = "rustfall.netToken";
export const DISPLAY_NAME_KEY = "rustfall.displayName";

const SESSION_TTL_MS = 2 * 3600 * 1000; // expires_at = now + 2h, refreshed by heartbeat
const SESSION_STALE_MS = 5 * 60 * 1000; // no heartbeat for 5 min → pruned from the roster view
const LEASE_SECONDS = 9;
const LEASE_TICK_MS = 4000; // host renews, guests probe for failover on this timer
const SESSION_HEARTBEAT_MS = 30000;
const ROSTER_POLL_MS = 12000;

/** Readable 5-letter room code, ambiguous glyphs (0/O, 1/I/L) excluded. */
export function generateRoomCode(): string {
  const ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ABC[b % ABC.length]).join("");
}

/** One stable id per browser, so rejoins keep their session row. */
export function getPlayerId(): string {
  try {
    let id = localStorage.getItem(PLAYER_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(PLAYER_ID_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID(); // storageless session: ephemeral id
  }
}

function getToken(): string {
  try {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t) {
      t = crypto.randomUUID() + crypto.randomUUID();
      localStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  } catch {
    return "ephemeral-" + Math.random().toString(36).slice(2);
  }
}

/** SHA-256 of the per-browser token; falls back to FNV-1a off secure contexts. */
async function tokenHash(): Promise<string> {
  const t = getToken();
  try {
    if (crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* fall through to FNV */
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "fnv1a-" + (h >>> 0).toString(16);
}

interface SessionRow {
  player_id: string;
  display_name: string;
  expires_at: string;
}

export class NetClient {
  role: NetRole = "GUEST";
  worldId = "";
  displayName = "";
  playerId = "";
  roster: RosterEntry[] = [];

  // Engine-facing callbacks. All of them fire off the render loop; the engine
  // queues everything scene-facing and drains it in tick().
  onTransform: (m: TransformMsg) => void = () => {};
  onSnapshot: (m: EntSnapshotMsg) => void = () => {};
  onEvent: (m: EventMsg) => void = () => {};
  onRoster: (r: RosterEntry[]) => void = () => {};
  onRoleChange: (role: NetRole, reason: "claimed" | "failover" | "lost") => void = () => {};
  onStatus: (msg: string) => void = () => {};

  private sb: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private timers: number[] = [];
  private leaseOwner = "";
  private stopped = false;
  private lastShotAt = new Map<string, number>();
  private joined = false;
  private unloadHook = () => this.beaconLeave();

  constructor() {
    this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /**
   * Join a room: upsert the room row (creating it with the seeded-world
   * metadata when new), upsert a session, then try the lease — claim it and
   * you are HOST, otherwise you are a GUEST. Throws on any failure; the
   * caller is expected to fall back to solo.
   */
  async join(code: string, displayName: string): Promise<NetRole> {
    this.worldId = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(this.worldId)) throw new Error("bad room code");
    this.displayName = (displayName.trim() || "DRIFTER").toUpperCase().slice(0, 14);
    this.playerId = getPlayerId();
    const hash = await tokenHash();

    // ── room: verify protocol on an existing room, create a fresh one ──
    const { data: room, error: roomErr } = await this.sb
      .from("rustfall_rooms")
      .select("world_id, protocol_version")
      .eq("world_id", this.worldId)
      .maybeSingle();
    if (roomErr) throw roomErr;
    if (room && room.protocol_version !== PROTOCOL_VERSION) {
      throw new Error(`protocol mismatch: ${String(room.protocol_version)}`);
    }
    if (!room) {
      const { error } = await this.sb.from("rustfall_rooms").upsert(
        {
          world_id: this.worldId,
          world_seed: WORLD_SEED,
          protocol_version: PROTOCOL_VERSION,
          state: {},
          revision: 0,
        },
        { onConflict: "world_id" }
      );
      if (error) throw error;
    }

    // ── session row (roster membership) ──
    const { error: sessErr } = await this.sb.from("rustfall_player_sessions").upsert(
      {
        world_id: this.worldId,
        player_id: this.playerId,
        token_hash: hash,
        connection_id: crypto.randomUUID(),
        display_name: this.displayName,
        expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      },
      { onConflict: "world_id,player_id" }
    );
    if (sessErr) throw sessErr;

    // ── authority: the lease decides who runs the world ──
    const claimed = await this.claimLease();
    this.role = claimed ? "HOST" : "GUEST";
    if (claimed) this.leaseOwner = this.playerId;
    else await this.pollLease();

    // ── fast lane: broadcast channel ──
    const ch = this.sb.channel(`room:${this.worldId}`);
    ch.on("broadcast", { event: "t" }, (msg) => {
      const p = msg.payload as TransformMsg;
      if (p && p.id !== this.playerId) this.onTransform(p);
    });
    ch.on("broadcast", { event: "ents" }, (msg) => {
      if (this.role === "GUEST") this.onSnapshot(msg.payload as EntSnapshotMsg);
    });
    ch.on("broadcast", { event: "ev" }, (msg) => {
      const p = msg.payload as EventMsg;
      if (p) this.routeEvent(p);
    });
    ch.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "rustfall_player_sessions", filter: `world_id=eq.${this.worldId}` },
      () => void this.refreshRoster()
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      ch.subscribe((status, err) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          settled = true;
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          settled = true;
          reject(err ?? new Error(`channel ${status}`));
        }
      });
    });
    this.channel = ch;

    await this.refreshRoster();

    // ── heartbeats ──
    this.timers.push(
      window.setInterval(() => void this.leaseTick(), LEASE_TICK_MS),
      window.setInterval(() => void this.sessionHeartbeat(), SESSION_HEARTBEAT_MS),
      window.setInterval(() => void this.refreshRoster(), ROSTER_POLL_MS)
    );
    window.addEventListener("pagehide", this.unloadHook);
    this.joined = true;
    return this.role;
  }

  // ── outbound fast lane (all fire-and-forget; the loop never awaits) ──

  sendTransform(m: TransformMsg) {
    void this.channel?.send({ type: "broadcast", event: "t", payload: m });
  }

  sendSnapshot(m: EntSnapshotMsg) {
    if (this.role !== "HOST") return;
    void this.channel?.send({ type: "broadcast", event: "ents", payload: m });
  }

  sendEvent(m: EventMsg) {
    void this.channel?.send({ type: "broadcast", event: "ev", payload: m });
  }

  /** Guest → host: "my shot landed on this entity for this much damage". */
  hitEntity(netId: string, dmg: number) {
    this.sendEvent({ k: "shot", id: netId, d: Math.round(dmg), by: this.playerId });
  }

  // ── events that need sender-side filtering before the engine sees them ──

  private routeEvent(p: EventMsg) {
    if (p.k === "shot") {
      if (this.role !== "HOST") return; // only the host applies damage
      const by = typeof p.by === "string" ? p.by : "";
      const now = performance.now();
      const last = this.lastShotAt.get(by) ?? 0;
      if (now - last < 90) return; // one damage event per guest per ~90 ms
      this.lastShotAt.set(by, now);
    } else if (p.k === "host") {
      // failover announcement: move the crown immediately, poll confirms later
      if (typeof p.id === "string") {
        this.leaseOwner = p.id;
        this.crownRoster();
      }
      return;
    }
    this.onEvent(p);
  }

  // ── lease: host renews, guests probe for a dead host (failover) ──

  private async claimLease(): Promise<boolean> {
    const { data, error } = await this.sb.rpc("try_claim_rustfall_lease", {
      p_world_id: this.worldId,
      p_owner_id: this.playerId,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (error) return false;
    return data === true;
  }

  private async pollLease() {
    const { data } = await this.sb
      .from("rustfall_room_leases")
      .select("owner_id, lease_until")
      .eq("world_id", this.worldId)
      .maybeSingle();
    if (data && typeof data.owner_id === "string" && data.owner_id !== this.leaseOwner) {
      this.leaseOwner = data.owner_id;
      this.crownRoster();
    }
  }

  private async leaseTick() {
    if (this.stopped) return;
    if (this.role === "HOST") {
      const ok = await this.claimLease();
      if (!ok && !this.stopped) {
        // lost the lease to a concurrent claim — demote rather than fork the world
        this.role = "GUEST";
        this.onRoleChange("GUEST", "lost");
        this.onStatus("HOST LEASE LOST — ANOTHER DRIFTER RUNS THE WORLD");
        await this.pollLease();
      }
    } else {
      const claimed = await this.claimLease();
      if (claimed && !this.stopped) {
        this.role = "HOST";
        this.leaseOwner = this.playerId;
        this.crownRoster();
        this.sendEvent({ k: "host", id: this.playerId });
        this.onRoleChange("HOST", "failover");
      } else {
        await this.pollLease();
      }
    }
  }

  private crownRoster() {
    this.roster = this.roster.map((r) => ({ ...r, host: r.id === this.leaseOwner }));
    this.onRoster(this.roster);
  }

  // ── roster: sessions table, pruned to rows with a heartbeat < 5 min old ──

  private async refreshRoster() {
    if (this.stopped) return;
    const { data, error } = await this.sb
      .from("rustfall_player_sessions")
      .select("player_id, display_name, expires_at")
      .eq("world_id", this.worldId);
    if (error || !data || this.stopped) return;
    // heartbeat writes expires_at = now + 2h; "alive" = heartbeat within 5 min
    const aliveAfter = Date.now() + (SESSION_TTL_MS - SESSION_STALE_MS);
    const roster: RosterEntry[] = (data as SessionRow[])
      .filter((r) => new Date(r.expires_at).getTime() > aliveAfter)
      .map((r) => ({ id: r.player_id, name: r.display_name, host: r.player_id === this.leaseOwner }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const changed =
      roster.length !== this.roster.length ||
      roster.some((r, i) => r.id !== this.roster[i]?.id || r.host !== this.roster[i]?.host);
    this.roster = roster;
    if (changed) this.onRoster(roster);
  }

  private async sessionHeartbeat() {
    if (this.stopped) return;
    await this.sb
      .from("rustfall_player_sessions")
      .update({ expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() })
      .eq("world_id", this.worldId)
      .eq("player_id", this.playerId);
  }

  // ── leaving: graceful on LEAVE, best-effort keepalive on tab death ──

  async leave() {
    if (!this.joined && this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
    window.removeEventListener("pagehide", this.unloadHook);
    try {
      if (this.role === "HOST") {
        await this.sb.rpc("release_rustfall_lease", { p_world_id: this.worldId, p_owner_id: this.playerId });
      }
      await this.sb
        .from("rustfall_player_sessions")
        .delete()
        .eq("world_id", this.worldId)
        .eq("player_id", this.playerId);
    } catch {
      /* leaving is best-effort; lease and session both expire on their own */
    }
    if (this.channel) {
      try {
        await this.sb.removeChannel(this.channel);
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
  }

  /** fetch(keepalive) — the only way to send headers on a dying page. */
  private beaconLeave() {
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    };
    try {
      if (this.role === "HOST") {
        void fetch(`${SUPABASE_URL}/rest/v1/rpc/release_rustfall_lease`, {
          method: "POST",
          headers,
          body: JSON.stringify({ p_world_id: this.worldId, p_owner_id: this.playerId }),
          keepalive: true,
        });
      }
      void fetch(
        `${SUPABASE_URL}/rest/v1/rustfall_player_sessions?world_id=eq.${this.worldId}&player_id=eq.${this.playerId}`,
        { method: "DELETE", headers, keepalive: true }
      );
    } catch {
      /* the lease expires in 9 s regardless — failover self-heals */
    }
  }
}
