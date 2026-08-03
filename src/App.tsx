import { useEffect, useRef, useState } from "react";
import { Game, type HudState } from "@/game/engine";
import { PIECES } from "@/game/build";
import { MECH_PARTS } from "@/game/entities";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

const INITIAL_HUD: HudState = {
  hp: 100, bossHp: null, mode: "FOOT", layer: "game", building: false,
  buildPiece: "", buildLegal: false, buildSnapped: false, buildReason: "", interact: null,
  kills: 0, scrap: 0, vehicleName: null, seatName: null, mechParts: null, mechStats: null,
  mechBayOpen: false, issues: 0, address: "0, 0, 0",
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState>(INITIAL_HUD);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const game = new Game(canvasRef.current!);
    gameRef.current = game;
    game.onHud = (h) => setHud((prev) => (JSON.stringify(prev) === JSON.stringify(h) ? prev : h));
    game.init().then(() => setReady(true));
    return () => game.dispose();
  }, []);

  const setLayer = (inspection: boolean) => {
    gameRef.current?.setLayer(inspection ? "inspection" : "game");
  };

  return (
    <div className="fixed inset-0 bg-black overflow-hidden select-none">
      <canvas ref={canvasRef} className="w-full h-full block" />

      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950 text-amber-200 z-50">
          <div className="text-4xl font-black tracking-[0.4em] mb-3">RUSTFALL</div>
          <div className="text-xs tracking-widest text-zinc-500 animate-pulse">FORGING WASTELAND · SLICING TEXTURE ATLASES…</div>
        </div>
      )}

      {/* crosshair */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10">
        <div className="w-2 h-2 rounded-full border border-amber-200/80" />
      </div>

      {/* top-left: title + vitals */}
      <div className="absolute top-4 left-4 z-20 text-amber-100">
        <div className="text-lg font-black tracking-[0.3em] drop-shadow">RUSTFALL</div>
        <div className="mt-2 w-52">
          <div className="flex justify-between text-[10px] tracking-widest text-zinc-300"><span>INTEGRITY</span><span>{hud.hp}</span></div>
          <div className="h-2 bg-zinc-800/80 border border-zinc-600"><div className="h-full bg-gradient-to-r from-red-700 to-amber-500" style={{ width: `${hud.hp}%` }} /></div>
        </div>
        {hud.bossHp !== null && (
          <div className="mt-2 w-64">
            <div className="flex justify-between text-[10px] tracking-widest text-red-300"><span>⚠ IRON WARDEN</span><span>{hud.bossHp}/500</span></div>
            <div className="h-2.5 bg-zinc-900/80 border border-red-800"><div className="h-full bg-red-600" style={{ width: `${(hud.bossHp / 500) * 100}%` }} /></div>
          </div>
        )}
        <div className="mt-2 flex gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px] tracking-widest border-zinc-600 text-zinc-300">{hud.mode}</Badge>
          <Badge variant="outline" className="text-[10px] tracking-widest border-zinc-600 text-zinc-300">KILLS {hud.kills}</Badge>
          <Badge variant="outline" className="text-[10px] tracking-widest border-amber-700 text-amber-300">⛏ SCRAP {hud.scrap}</Badge>
          <Badge variant="outline" className={`text-[10px] tracking-widest ${hud.layer === "inspection" ? "border-cyan-400 text-cyan-300" : "border-zinc-600 text-zinc-300"}`}>
            {hud.layer === "inspection" ? "◈ INSPECTION LAYER" : "GAME LAYER"}
          </Badge>
        </div>
        {hud.vehicleName && (
          <div className="mt-2 rounded border border-emerald-700 bg-zinc-950/85 px-3 py-2 w-64">
            <div className="flex justify-between items-center">
              <span className="text-[10px] tracking-widest text-emerald-400">🛻 {hud.vehicleName}</span>
              <span className="text-[10px] tracking-widest text-amber-300">SEAT: {hud.seatName}</span>
            </div>
            <div className="text-[9px] text-zinc-500 mt-1 tracking-wider">
              {hud.seatName === "DRIVER" ? "WASD TO DRIVE" : "RIDING — ONLY THE DRIVER STEERS"} · [Q] SWITCH SEAT · [E] EXIT
            </div>
          </div>
        )}
      </div>

      {/* settings gear */}
      <div className="absolute top-4 right-4 z-30">
        <Button variant="outline" size="sm" onClick={() => setSettingsOpen(!settingsOpen)}
          className="bg-zinc-900/80 border-zinc-600 text-zinc-200 hover:bg-zinc-800 tracking-widest text-xs">
          ⚙ SETTINGS
        </Button>
      </div>

      {/* settings panel — home of THE LAYER SWITCH */}
      {settingsOpen && (
        <div className="absolute top-14 right-4 z-30 w-80 rounded-md border border-zinc-600 bg-zinc-950/95 p-4 text-zinc-200 shadow-2xl">
          <div className="text-xs font-bold tracking-[0.25em] text-amber-200 mb-3">SETTINGS</div>

          <div className="rounded border border-cyan-800 bg-cyan-950/30 p-3 mb-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold tracking-widest text-cyan-300">WORLD LAYER</div>
                <div className="text-[10px] text-zinc-400 mt-0.5">
                  {hud.layer === "inspection" ? "◈ Inspection: grid · IDs · addresses · bounds" : "Game: the living wasteland"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400">GAME</span>
                <Switch checked={hud.layer === "inspection"} onCheckedChange={setLayer} />
                <span className="text-[10px] text-cyan-300">INSPECT</span>
              </div>
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant={hud.layer === "game" ? "default" : "outline"}
                className="flex-1 text-[10px] tracking-widest" onClick={() => setLayer(false)}>🎮 GAME VIEW</Button>
              <Button size="sm" variant={hud.layer === "inspection" ? "default" : "outline"}
                className="flex-1 text-[10px] tracking-widest border-cyan-700 text-cyan-300" onClick={() => setLayer(true)}>◈ INSPECTION</Button>
            </div>
          </div>

          <div className="text-[10px] leading-relaxed text-zinc-400 space-y-1 border-t border-zinc-800 pt-2">
            <div className="flex justify-between"><span>VALIDATION ISSUES</span><span className={hud.issues === 0 ? "text-emerald-400" : "text-red-400"}>{hud.issues}</span></div>
            <div className="flex justify-between"><span>POSITION</span><span className="text-zinc-300">{hud.address}</span></div>
          </div>

          <div className="mt-3 border-t border-zinc-800 pt-2 text-[10px] text-zinc-500 leading-relaxed">
            <span className="text-zinc-300">WASD</span> move · <span className="text-zinc-300">SHIFT</span> sprint · <span className="text-zinc-300">CLICK</span> fire/punch ·{" "}
            <span className="text-zinc-300">E</span> board/exit · <span className="text-zinc-300">Q</span> switch seat · <span className="text-zinc-300">B</span> build · <span className="text-zinc-300">1-6</span> piece ·{" "}
            <span className="text-zinc-300">R</span> rotate · <span className="text-zinc-300">M</span> mech bay · <span className="text-zinc-300">L</span> layer
          </div>
        </div>
      )}

      {/* interact prompt */}
      {hud.interact && (
        <div className="absolute bottom-36 left-1/2 -translate-x-1/2 z-20 rounded border border-amber-500/60 bg-zinc-950/85 px-4 py-2 text-amber-200 text-xs tracking-[0.25em]">
          [E] {hud.interact}
        </div>
      )}

      {/* build bar */}
      {hud.building && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 rounded-md border border-emerald-700 bg-zinc-950/90 px-4 py-3">
          <div className="text-[10px] tracking-[0.3em] text-emerald-400 mb-2">🔨 COMMUNITY BUILD MODE — snap {hud.buildPiece.includes("SANDBAG") ? "1m" : "4m"} grid</div>
          <div className="flex gap-2">
            {PIECES.map((p, i) => (
              <div key={p.key} className={`px-2 py-1 rounded border text-[10px] tracking-wider ${p.label === hud.buildPiece ? "border-emerald-400 text-emerald-300" : "border-zinc-700 text-zinc-500"}`}>
                {i + 1}·{p.label}
              </div>
            ))}
          </div>
          <div className={`mt-2 text-[10px] tracking-widest ${!hud.buildLegal ? "text-red-400" : hud.buildSnapped ? "text-cyan-300" : "text-emerald-400"}`}>
            {!hud.buildLegal
              ? `✗ ${hud.buildReason.toUpperCase() || "AIM AT GROUND"}`
              : hud.buildSnapped
                ? "⇄ CONNECTOR SNAPPED — CLICK TO SEAT THE PIECE"
                : "✓ GRID PLACEMENT LEGAL — CLICK TO BUILD"}
          </div>
        </div>
      )}

      {/* mech bay: every part swappable, stats re-solved live */}
      {hud.mechBayOpen && hud.mechParts && hud.mechStats && (
        <div className="absolute bottom-6 left-4 z-20 w-80 rounded-md border border-sky-700 bg-zinc-950/95 p-4 text-zinc-200">
          <div className="text-xs font-bold tracking-[0.25em] text-sky-300 mb-1">⚙ MECH BAY — MODULAR FRAME</div>
          <div className="text-[10px] text-zinc-500 mb-3">Every bar of the frame re-forges. Press M to close.</div>
          {(["torso", "arms", "legs"] as const).map((slot) => (
            <div key={slot} className="flex items-center justify-between mb-2">
              <div>
                <div className="text-[9px] tracking-widest text-zinc-500">{slot.toUpperCase()}</div>
                <div className="text-xs text-sky-100">{hud.mechParts![slot]}</div>
              </div>
              <Button size="sm" variant="outline" className="text-[10px] border-sky-800 text-sky-300"
                onClick={() => gameRef.current?.cycleMechPart(slot)}>
                SWAP ▸ {MECH_PARTS[slot][(MECH_PARTS[slot].findIndex((p) => p.name === hud.mechParts![slot]) + 1) % MECH_PARTS[slot].length].name.split(" ")[0]}
              </Button>
            </div>
          ))}
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2 text-center">
            <div><div className="text-[9px] text-zinc-500 tracking-widest">SPEED</div><div className="text-sm text-amber-200">{hud.mechStats.speed.toFixed(1)}</div></div>
            <div><div className="text-[9px] text-zinc-500 tracking-widest">ARMOR</div><div className="text-sm text-amber-200">{hud.mechStats.armor}</div></div>
            <div><div className="text-[9px] text-zinc-500 tracking-widest">POWER</div><div className="text-sm text-amber-200">{hud.mechStats.power}</div></div>
          </div>
        </div>
      )}

      {/* boot hint */}
      {ready && (
        <div className="absolute bottom-2 right-4 z-10 text-[10px] text-zinc-500 tracking-widest">
          CLICK WORLD TO CAPTURE MOUSE · ⚙ SETTINGS → WORLD LAYER TO SEE THE OTHER SIDE
        </div>
      )}
    </div>
  );
}
