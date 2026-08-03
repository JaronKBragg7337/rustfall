import { useCallback, useEffect, useRef, useState } from "react";
import { Game, type HudState } from "@/game/engine";
import type { TouchState } from "@/game/touch";
import { PIECES } from "@/game/build";
import { MECH_PARTS } from "@/game/entities";
import { IS_TOUCH } from "@/game/constants";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

const INITIAL_HUD: HudState = {
  hp: 100, bossHp: null, mode: "FOOT", layer: "game", building: false,
  buildPiece: "", buildLegal: false, buildSnapped: false, buildReason: "", interact: null,
  kills: 0, scrap: 0, vehicleName: null, seatName: null, mechParts: null, mechStats: null,
  mechBayOpen: false, issues: 0, address: "0, 0, 0", nearby: [], muted: false, timeOfDay: 0.42, clock: "10:04", dust: 0, timeFrozen: false, toast: "", lootLeft: 0,
  firstPerson: false, devMode: false, safe: false, cinematic: false, shotName: "", shotCaption: "", shotProgress: 0,
};

/**
 * Touch action button. Uses pointer events rather than onClick so a press
 * registers immediately and a held finger keeps firing, and so the press never
 * steals focus or triggers the browser's 300 ms tap delay.
 */
function TouchBtn({
  label, sub, onDown, onUp, className = "",
}: {
  label: string; sub?: string; onDown: () => void; onUp?: () => void; className?: string;
}) {
  return (
    <button
      onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); onDown(); }}
      onPointerUp={(e) => { e.preventDefault(); onUp?.(); }}
      onPointerCancel={() => onUp?.()}
      onContextMenu={(e) => e.preventDefault()}
      className={`select-none touch-none rounded-full border border-amber-500/50 bg-zinc-950/70 backdrop-blur-sm
        text-amber-200 active:bg-amber-600/40 active:border-amber-300 flex flex-col items-center justify-center
        leading-none shadow-lg ${className}`}
    >
      <span className="font-bold tracking-wider">{label}</span>
      {sub && <span className="text-[8px] text-zinc-400 mt-0.5 tracking-widest">{sub}</span>}
    </button>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [touch, setTouch] = useState<TouchState | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const game = new Game(canvasRef.current!);
    gameRef.current = game;
    game.onHud = (h) => setHud((prev) => (JSON.stringify(prev) === JSON.stringify(h) ? prev : h));
    game.onTouch = (t) => setTouch(t ? { ...t } : null);
    game.init().then(() => setReady(true));
    return () => game.dispose();
  }, []);

  const setLayer = useCallback((inspection: boolean) => {
    gameRef.current?.setLayer(inspection ? "inspection" : "game");
  }, []);

  const g = () => gameRef.current;
  const joyVisible = IS_TOUCH && touch?.joyActive;

  return (
    <div className="fixed inset-0 bg-black overflow-hidden select-none">
      <canvas ref={canvasRef} className="w-full h-full block touch-none" />

      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950 text-amber-200 z-50 px-6 text-center">
          <div className="text-2xl sm:text-4xl font-black tracking-[0.3em] sm:tracking-[0.4em] mb-3">RUSTFALL</div>
          <div className="text-[10px] sm:text-xs tracking-widest text-zinc-500 animate-pulse">
            FORGING WASTELAND · SLICING TEXTURE ATLASES…
          </div>
        </div>
      )}

      {/* crosshair — hidden during the tour, nobody is aiming */}
      {!hud.cinematic && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10">
          <div className="w-2 h-2 rounded-full border border-amber-200/80" />
        </div>
      )}

      {/* ── SHOWCASE TOUR overlay ── */}
      {hud.cinematic && (
        <div className="absolute inset-0 z-40 pointer-events-none">
          {/* letterbox bars sell it as a film and hide the HUD edges */}
          <div className="absolute inset-x-0 top-0 h-[7vh] bg-black" />
          <div className="absolute inset-x-0 bottom-0 h-[7vh] bg-black" />

          <div className="absolute left-4 sm:left-8 bottom-[9vh] max-w-[80vw]">
            <div className="text-[9px] tracking-[0.4em] text-fuchsia-300/90 mb-1">RUSTFALL · SHOWCASE</div>
            <div className="text-xl sm:text-3xl font-black tracking-[0.16em] text-amber-100 drop-shadow-lg">
              {hud.shotName}
            </div>
            <div className="text-[10px] sm:text-xs tracking-widest text-zinc-300/90 mt-1">{hud.shotCaption}</div>
            <div className="mt-2 h-[2px] w-40 sm:w-64 bg-white/15">
              <div className="h-full bg-amber-300/80 transition-[width] duration-200" style={{ width: `${hud.shotProgress * 100}%` }} />
            </div>
          </div>

          <div className="absolute right-4 sm:right-8 bottom-[9vh] text-right">
            <div className={`text-[10px] sm:text-xs tracking-[0.25em] ${hud.layer === "inspection" ? "text-cyan-300" : "text-amber-200"}`}>
              {hud.layer === "inspection" ? "◈ INSPECTION LAYER" : "◆ GAME LAYER"}
            </div>
            <div className="text-[9px] text-zinc-500 mt-0.5 tracking-widest">AUTO-SWITCHING</div>
          </div>

          <div className="absolute inset-x-0 top-[8vh] flex justify-center gap-2 pointer-events-auto">
            <button onPointerDown={() => gameRef.current?.nextShot()}
              className="px-3 py-1.5 rounded-full border border-white/25 bg-black/50 text-zinc-200 text-[10px] tracking-widest backdrop-blur-sm">
              SKIP ▸
            </button>
            <button onPointerDown={() => gameRef.current?.toggleCinematic()}
              className="px-3 py-1.5 rounded-full border border-white/25 bg-black/50 text-zinc-200 text-[10px] tracking-widest backdrop-blur-sm">
              ✕ EXIT TOUR
            </button>
          </div>
        </div>
      )}

      {/* ── top-left vitals: compact on phones so it never eats the viewport ── */}
      {!hud.cinematic && (
      <div className="absolute top-2 left-2 sm:top-4 sm:left-4 z-20 text-amber-100 pointer-events-none">
        <div className="text-sm sm:text-lg font-black tracking-[0.25em] sm:tracking-[0.3em] drop-shadow">RUSTFALL</div>
        <div className="mt-1 sm:mt-2 w-32 sm:w-52">
          <div className="flex justify-between text-[8px] sm:text-[10px] tracking-widest text-zinc-300">
            <span>INTEGRITY</span><span>{hud.hp}</span>
          </div>
          <div className="h-1.5 sm:h-2 bg-zinc-800/80 border border-zinc-600">
            <div className="h-full bg-gradient-to-r from-red-700 to-amber-500 transition-[width] duration-150" style={{ width: `${hud.hp}%` }} />
          </div>
        </div>
        {hud.bossHp !== null && (
          <div className="mt-1.5 sm:mt-2 w-40 sm:w-64">
            <div className="flex justify-between text-[8px] sm:text-[10px] tracking-widest text-red-300">
              <span>⚠ IRON WARDEN</span><span>{hud.bossHp}/500</span>
            </div>
            <div className="h-2 sm:h-2.5 bg-zinc-900/80 border border-red-800">
              <div className="h-full bg-red-600" style={{ width: `${(hud.bossHp / 500) * 100}%` }} />
            </div>
          </div>
        )}
        <div className="mt-1.5 sm:mt-2 flex gap-1 sm:gap-2 flex-wrap max-w-[60vw]">
          <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-zinc-600 text-zinc-300">{hud.mode}</Badge>
          <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-zinc-600 text-zinc-300">☠ {hud.kills}</Badge>
          <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-amber-700 text-amber-300">⛏ {hud.scrap}</Badge>
          <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-zinc-600 text-zinc-400">◆ {hud.lootLeft}</Badge>
          {hud.layer === "inspection" && (
            <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-cyan-400 text-cyan-300">◈ INSPECT</Badge>
          )}
          {hud.devMode && (
            <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-fuchsia-400 text-fuchsia-300">⚑ DEV · INVULNERABLE</Badge>
          )}
          <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-zinc-600 text-zinc-300">
            🕓 {hud.clock}
          </Badge>
          {hud.dust > 0.15 && (
            <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-orange-500 text-orange-300">
              🌪 DUST STORM
            </Badge>
          )}
          {hud.safe && (
            <Badge variant="outline" className="text-[8px] sm:text-[10px] px-1.5 py-0 tracking-widest border-emerald-400 text-emerald-300">✚ SAFE ZONE</Badge>
          )}
        </div>
        {hud.vehicleName && (
          <div className="mt-1.5 sm:mt-2 rounded border border-emerald-700 bg-zinc-950/85 px-2 py-1 sm:px-3 sm:py-2 w-44 sm:w-64">
            <div className="flex justify-between items-center gap-2">
              <span className="text-[9px] sm:text-[10px] tracking-widest text-emerald-400 truncate">🛻 {hud.vehicleName}</span>
              <span className="text-[9px] sm:text-[10px] tracking-widest text-amber-300 shrink-0">{hud.seatName}</span>
            </div>
            <div className="hidden sm:block text-[9px] text-zinc-500 mt-1 tracking-wider">
              {hud.seatName === "DRIVER" ? "WASD TO DRIVE" : "RIDING — ONLY THE DRIVER STEERS"} · [Q] SWITCH SEAT · [E] EXIT
            </div>
          </div>
        )}
      </div>
      )}

      {/* ── settings ── */}
      {!hud.cinematic && (
      <div className="absolute top-2 right-2 sm:top-4 sm:right-4 z-30 flex items-start">
        <Button variant="outline" size="sm" onPointerDown={() => g()?.toggleMute()}
          className="h-7 px-2 sm:h-8 sm:px-3 mr-1.5 bg-zinc-900/80 border-zinc-600 text-zinc-200 hover:bg-zinc-800 text-[11px]">
          {hud.muted ? "🔇" : "🔊"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSettingsOpen(!settingsOpen)}
          className="h-7 px-2 sm:h-8 sm:px-3 bg-zinc-900/80 border-zinc-600 text-zinc-200 hover:bg-zinc-800 tracking-widest text-[10px] sm:text-xs">
          ⚙<span className="hidden sm:inline ml-1">SETTINGS</span>
        </Button>
      </div>
      )}

      {/* Tap-away backdrop: on a phone the panel covers most of the view, so it
          must be dismissible without hunting for the small gear icon again. */}
      {settingsOpen && (
        <div className="absolute inset-0 z-20" onPointerDown={() => setSettingsOpen(false)} />
      )}

      {settingsOpen && (
        <div className="absolute top-11 right-2 sm:top-14 sm:right-4 z-30 w-[min(19rem,calc(100vw-1rem))]
                        max-h-[55vh] overflow-y-auto rounded-md border border-zinc-600 bg-zinc-950/95
                        p-2.5 sm:p-4 text-zinc-200 shadow-2xl">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] sm:text-xs font-bold tracking-[0.25em] text-amber-200">SETTINGS</div>
            <button onPointerDown={() => setSettingsOpen(false)}
              className="w-7 h-7 -mr-1 rounded text-zinc-400 hover:text-zinc-100 text-base leading-none">✕</button>
          </div>
          <div className="rounded border border-cyan-800 bg-cyan-950/30 p-2 sm:p-3 mb-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] sm:text-xs font-bold tracking-widest text-cyan-300">WORLD LAYER</div>
                <div className="text-[9px] sm:text-[10px] text-zinc-400 mt-0.5">
                  {hud.layer === "inspection" ? "◈ Grid · IDs · bounds" : "Game: the living wasteland"}
                </div>
              </div>
              <Switch checked={hud.layer === "inspection"} onCheckedChange={setLayer} />
            </div>
          </div>
          {/* time of day */}
          <div className="rounded border border-zinc-700 bg-zinc-900/40 p-2 sm:p-3 mb-2">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[11px] sm:text-xs font-bold tracking-widest text-amber-200">TIME · {hud.clock}</div>
              <button onPointerDown={() => g()?.toggleTimeFrozen()}
                className={`text-[9px] px-1.5 py-0.5 rounded border tracking-widest ${
                  hud.timeFrozen ? "border-amber-400 text-amber-200" : "border-zinc-700 text-zinc-500"}`}>
                {hud.timeFrozen ? "❚❚ FROZEN" : "▶ RUNNING"}
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {([["DAWN", 0.25], ["NOON", 0.5], ["DUSK", 0.755], ["NIGHT", 0.0]] as const).map(([label, t]) => (
                <button key={label} onPointerDown={() => g()?.setTimeOfDay(t)}
                  className="py-1.5 rounded border border-zinc-700 text-zinc-300 text-[9px] tracking-widest active:border-amber-400 active:text-amber-200">
                  {label}
                </button>
              ))}
            </div>
            <input type="range" min={0} max={1} step={0.005} value={hud.timeOfDay}
              onChange={(e) => g()?.setTimeOfDay(parseFloat(e.target.value))}
              className="w-full mt-2 accent-amber-400" />
            <button onPointerDown={() => g()?.setDustStorm(hud.dust < 0.2)}
              className={`mt-1 w-full py-1.5 rounded border text-[10px] tracking-widest ${
                hud.dust > 0.2 ? "border-orange-400 text-orange-200 bg-orange-500/15" : "border-zinc-700 text-zinc-400"}`}>
              {hud.dust > 0.2 ? "🌪 DUST STORM ON" : "SUMMON DUST STORM"}
            </button>
          </div>

          {/* view mode */}
          <div className="rounded border border-zinc-700 bg-zinc-900/40 p-2 sm:p-3 mb-2">
            <div className="text-[11px] sm:text-xs font-bold tracking-widest text-amber-200 mb-1.5">VIEW</div>
            <div className="flex gap-1.5">
              <button onPointerDown={() => g()?.toggleFirstPerson()}
                className={`flex-1 py-1.5 rounded border text-[10px] tracking-widest ${
                  hud.firstPerson ? "border-amber-400 text-amber-200 bg-amber-500/15" : "border-zinc-700 text-zinc-400"}`}>
                {hud.firstPerson ? "● FIRST PERSON" : "FIRST PERSON"}
              </button>
              <button onPointerDown={() => g()?.toggleFirstPerson()}
                className={`flex-1 py-1.5 rounded border text-[10px] tracking-widest ${
                  !hud.firstPerson ? "border-amber-400 text-amber-200 bg-amber-500/15" : "border-zinc-700 text-zinc-400"}`}>
                {!hud.firstPerson ? "● THIRD PERSON" : "THIRD PERSON"}
              </button>
            </div>
            <button onPointerDown={() => g()?.toggleDevMode()}
              className={`mt-1.5 w-full py-1.5 rounded border text-[10px] tracking-widest ${
                hud.devMode ? "border-fuchsia-400 text-fuchsia-200 bg-fuchsia-500/15" : "border-zinc-700 text-zinc-400"}`}>
              {hud.devMode ? "⚑ DEV MODE ON" : "DEV MODE (INVULNERABLE)"}
            </button>
            <div className="text-[9px] text-zinc-500 mt-1 leading-snug">
              Turns on automatically in the inspection layer so bug-hunting can't get you killed.
            </div>

            <button
              onPointerDown={() => { g()?.toggleCinematic(); setSettingsOpen(false); }}
              className="mt-2 w-full py-2 rounded border border-fuchsia-600/70 bg-fuchsia-500/10 text-fuchsia-200
                         text-[11px] tracking-[0.2em] font-bold active:bg-fuchsia-500/25">
              ▶ SHOWCASE TOUR
            </button>
            <div className="text-[9px] text-zinc-500 mt-1 leading-snug">
              Hands the camera to an automatic tour of the world, flipping between
              the game and inspection layers as it goes.
            </div>
          </div>

          <div className="text-[10px] leading-relaxed text-zinc-400 space-y-1 border-t border-zinc-800 pt-2">
            <div className="flex justify-between"><span>VALIDATION ISSUES</span><span className={hud.issues === 0 ? "text-emerald-400" : "text-red-400"}>{hud.issues}</span></div>
            <div className="flex justify-between"><span>POSITION</span><span className="text-zinc-300">{hud.address}</span></div>
          </div>
          <button onClick={() => setShowHelp(!showHelp)} className="mt-3 w-full text-[10px] tracking-widest text-zinc-400 border-t border-zinc-800 pt-2 text-left hover:text-zinc-200">
            {showHelp ? "▾" : "▸"} CONTROLS
          </button>
          {showHelp && (
            <div className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
              {IS_TOUCH ? (
                <>Left thumb drag = move (push far to sprint) · Right thumb drag = look · Buttons at right = fire, jump, interact, build.</>
              ) : (
                <><span className="text-zinc-300">WASD</span> move · <span className="text-zinc-300">SHIFT</span> sprint · <span className="text-zinc-300">SPACE</span> jump ·{" "}
                <span className="text-zinc-300">CTRL</span> crouch · <span className="text-zinc-300">CLICK</span> fire · <span className="text-zinc-300">E</span> board/exit ·{" "}
                <span className="text-zinc-300">Q</span> seat · <span className="text-zinc-300">B</span> build · <span className="text-zinc-300">1-6</span> piece ·{" "}
                <span className="text-zinc-300">R</span> rotate · <span className="text-zinc-300">M</span> mech bay · <span className="text-zinc-300">L</span> layer</>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── nearby assets, screen space ──
          World-space labels get occluded and have to be OCR'd off a screenshot.
          This is the same data as plain text that always reads cleanly, which is
          what makes a screenshot enough to describe a bug precisely. */}
      {hud.layer === "inspection" && hud.nearby.length > 0 && !hud.cinematic && (
        <div className="absolute right-2 bottom-2 sm:right-4 sm:bottom-4 z-20 w-[min(21rem,calc(100vw-1rem))]
                        rounded border border-amber-700/70 bg-zinc-950/90 p-2 font-mono text-[9px] sm:text-[10px] leading-snug">
          <div className="flex items-center justify-between text-amber-300 tracking-widest mb-1">
            <span>◈ NEAREST ASSETS</span>
            <span className={hud.issues === 0 ? "text-emerald-400" : "text-red-400"}>{hud.issues} ISSUES</span>
          </div>
          <div className="text-zinc-500 mb-1">POS {hud.address}</div>
          {hud.nearby.map((a) => (
            <div key={a.id} className="flex gap-2 text-zinc-300">
              <span className="text-amber-200 shrink-0">{a.id}</span>
              <span className="text-zinc-500 truncate">{a.role}</span>
              <span className="ml-auto text-zinc-500 shrink-0">{a.address} · {a.dist}m</span>
            </div>
          ))}
        </div>
      )}

      {/* ── pickup / action confirmation ── */}
      {hud.toast && !hud.cinematic && (
        <div className="absolute bottom-40 sm:bottom-48 left-1/2 -translate-x-1/2 z-20 rounded border border-amber-400/70
                        bg-zinc-950/90 px-3 py-1.5 text-amber-200 text-[11px] sm:text-sm tracking-[0.2em] whitespace-nowrap">
          {hud.toast}
        </div>
      )}

      {/* ── interact prompt ── */}
      {hud.interact && !hud.cinematic && (
        <div className="absolute bottom-28 sm:bottom-36 left-1/2 -translate-x-1/2 z-20 rounded border border-amber-500/60 bg-zinc-950/85 px-3 py-1.5 sm:px-4 sm:py-2 text-amber-200 text-[10px] sm:text-xs tracking-[0.2em] whitespace-nowrap">
          {IS_TOUCH ? "▶" : "[E]"} {hud.interact}
        </div>
      )}

      {/* ── build bar ── */}
      {hud.building && (
        <div className="absolute bottom-2 sm:bottom-6 left-1/2 -translate-x-1/2 z-20 w-[min(38rem,calc(100vw-1rem))] rounded-md border border-emerald-700 bg-zinc-950/90 px-2 py-2 sm:px-4 sm:py-3">
          <div className="text-[9px] sm:text-[10px] tracking-[0.2em] text-emerald-400 mb-1.5">🔨 BUILD MODE</div>
          <div className="flex gap-1 sm:gap-2 overflow-x-auto pb-1">
            {PIECES.map((p, i) => (
              <button key={p.key} onClick={() => g()?.selectPiece(i)}
                className={`shrink-0 px-1.5 py-1 rounded border text-[9px] sm:text-[10px] tracking-wider ${
                  p.label === hud.buildPiece ? "border-emerald-400 text-emerald-300" : "border-zinc-700 text-zinc-500"}`}>
                {i + 1}·{p.label}
              </button>
            ))}
          </div>
          <div className={`mt-1 text-[9px] sm:text-[10px] tracking-widest ${!hud.buildLegal ? "text-red-400" : hud.buildSnapped ? "text-cyan-300" : "text-emerald-400"}`}>
            {!hud.buildLegal
              ? `✗ ${hud.buildReason.toUpperCase() || "AIM AT GROUND"}`
              : hud.buildSnapped ? "⇄ CONNECTOR SNAPPED" : "✓ PLACEMENT LEGAL"}
          </div>
        </div>
      )}

      {/* ── mech bay ── */}
      {hud.mechBayOpen && hud.mechParts && hud.mechStats && (
        <div className="absolute z-20 rounded-md border border-sky-700 bg-zinc-950/95 p-3 sm:p-4 text-zinc-200
                        left-2 right-2 bottom-2 sm:left-4 sm:right-auto sm:bottom-6 sm:w-80">
          <div className="text-[11px] sm:text-xs font-bold tracking-[0.25em] text-sky-300 mb-1">⚙ MECH BAY</div>
          <div className="text-[9px] sm:text-[10px] text-zinc-500 mb-2">Every bar of the frame re-forges.</div>
          {(["torso", "arms", "legs"] as const).map((slot) => (
            <div key={slot} className="flex items-center justify-between gap-2 mb-1.5">
              <div className="min-w-0">
                <div className="text-[8px] sm:text-[9px] tracking-widest text-zinc-500">{slot.toUpperCase()}</div>
                <div className="text-[11px] sm:text-xs text-sky-100 truncate">{hud.mechParts![slot]}</div>
              </div>
              <Button size="sm" variant="outline" className="h-7 text-[9px] sm:text-[10px] border-sky-800 text-sky-300 shrink-0"
                onClick={() => g()?.cycleMechPart(slot)}>
                SWAP ▸ {MECH_PARTS[slot][(MECH_PARTS[slot].findIndex((p) => p.name === hud.mechParts![slot]) + 1) % MECH_PARTS[slot].length].name.split(" ")[0]}
              </Button>
            </div>
          ))}
          <div className="mt-2 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2 text-center">
            <div><div className="text-[8px] sm:text-[9px] text-zinc-500 tracking-widest">SPEED</div><div className="text-sm text-amber-200">{hud.mechStats.speed.toFixed(1)}</div></div>
            <div><div className="text-[8px] sm:text-[9px] text-zinc-500 tracking-widest">ARMOR</div><div className="text-sm text-amber-200">{hud.mechStats.armor}</div></div>
            <div><div className="text-[8px] sm:text-[9px] text-zinc-500 tracking-widest">POWER</div><div className="text-sm text-amber-200">{hud.mechStats.power}</div></div>
          </div>
        </div>
      )}

      {/* ── TOUCH: floating joystick, drawn where the thumb landed ── */}
      {joyVisible && touch && (
        <div className="absolute z-20 pointer-events-none" style={{ left: touch.joyOx, top: touch.joyOy, transform: "translate(-50%,-50%)" }}>
          <div className={`w-[108px] h-[108px] rounded-full border-2 ${touch.sprint ? "border-amber-400/80" : "border-zinc-300/35"} bg-zinc-900/25`} />
          <div
            className={`absolute w-12 h-12 rounded-full ${touch.sprint ? "bg-amber-400/70" : "bg-zinc-200/45"} border border-zinc-100/50`}
            style={{ left: touch.joyKx - touch.joyOx, top: touch.joyKy - touch.joyOy, transform: "translate(-50%,-50%)" }}
          />
        </div>
      )}

      {/* ── TOUCH: action cluster, placed in the right thumb's natural arc ── */}
      {IS_TOUCH && ready && !hud.cinematic && (
        <div className="absolute z-30 right-3 bottom-5" style={{ paddingRight: "env(safe-area-inset-right)", paddingBottom: "env(safe-area-inset-bottom)" }}>
          <div className="relative w-40 h-40">
            <TouchBtn label="FIRE" className="absolute right-0 bottom-8 w-[68px] h-[68px] text-[11px]"
              onDown={() => g()?.setAction("fire", true)} onUp={() => g()?.setAction("fire", false)} />
            <TouchBtn label="⤒" sub="JUMP" className="absolute right-[72px] bottom-0 w-14 h-14 text-base"
              onDown={() => g()?.setAction("jump", true)} onUp={() => g()?.setAction("jump", false)} />
            <TouchBtn label="▶" sub="USE" className="absolute right-1 bottom-[86px] w-14 h-14 text-base"
              onDown={() => g()?.pressInteract()} />
            <TouchBtn label="⌂" sub="BUILD" className="absolute right-[80px] bottom-[64px] w-12 h-12 text-sm"
              onDown={() => g()?.toggleBuild()} />
          </div>
          {/* contextual extras only when they apply, so the screen stays clear */}
          <div className="absolute right-[168px] bottom-6 flex flex-col gap-2">
            {hud.building && (
              <TouchBtn label="↻" sub="ROT" className="w-12 h-12 text-sm" onDown={() => g()?.rotatePiece()} />
            )}
            {hud.mode === "VEHICLE" && (
              <TouchBtn label="⇄" sub="SEAT" className="w-12 h-12 text-sm" onDown={() => g()?.cycleSeat()} />
            )}
            {hud.mode === "MECH" && (
              <TouchBtn label="⚙" sub="BAY" className="w-12 h-12 text-sm" onDown={() => g()?.toggleMechBay()} />
            )}
          </div>
        </div>
      )}

      {/* ── boot hint (desktop only; phones get the buttons instead) ── */}
      {ready && !IS_TOUCH && !hud.cinematic && (
        <div className="absolute bottom-2 right-4 z-10 text-[10px] text-zinc-500 tracking-widest pointer-events-none">
          CLICK WORLD TO CAPTURE MOUSE · ⚙ SETTINGS → WORLD LAYER
        </div>
      )}
    </div>
  );
}
