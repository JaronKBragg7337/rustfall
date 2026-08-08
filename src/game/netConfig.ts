// Wasteland Commons — Supabase project configuration.
// The publishable key is public by design (open co-op policies, RLS anon);
// it is safe to embed in shipped client code.
export const SUPABASE_URL = "https://wnwxihhjtoilmcilyyuk.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_Spzw88sZvhP5kXgU2cW4zg_dn0CbtLd";

/** Rooms created by another build with a different protocol are rejected. */
export const PROTOCOL_VERSION = "rustfall-authoritative/1";
/**
 * The world is fully deterministic from hard-coded seeds (engine init:
 * 4242 population, 7717 loot, 9917 fuel, 8801 herds, 7702 suburb pack,
 * 6600 caches) — this string is metadata documenting that, not an input.
 */
export const WORLD_SEED = "rustfall/seeded-world/v1";
