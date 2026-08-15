// Supabase project configuration.
//
// This used to be its own project, "Wasteland Commons". It now runs on
// Heartbeat Observatory's, alongside every other game on the site.
//
// The reason is a hard limit rather than a preference: the free plan allows two
// active Supabase projects, Heartbeat has to be one of them, and any game
// holding its own project spends the only other slot. The five `rustfall_`
// tables, both lease functions and the realtime publication were copied over
// unchanged, so nothing about how this file's callers work had to change.
//
// The publishable key is public by design (open co-op policies, RLS anon); it
// is safe to embed in shipped client code.
export const SUPABASE_URL = "https://ygjpnvrwhkrowkrskftk.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Y-duV64ayMMEvVwMs5PWuw_6kvzbOrN";

/** Rooms created by another build with a different protocol are rejected. */
export const PROTOCOL_VERSION = "rustfall-authoritative/1";
/**
 * The world is fully deterministic from hard-coded seeds (engine init:
 * 4242 population, 7717 loot, 9917 fuel, 8801 herds, 7702 suburb pack,
 * 6600 caches) — this string is metadata documenting that, not an input.
 */
export const WORLD_SEED = "rustfall/seeded-world/v1";
