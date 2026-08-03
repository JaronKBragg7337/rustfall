// Touch input — multi-touch gestures on the canvas.
//
// Split by screen half: a thumb down on the left spawns a floating joystick at
// the touch point (fixed-position sticks force the thumb to hunt for them);
// a thumb on the right drags the camera. Each finger is tracked by pointerId so
// moving, looking and pressing an action button all work at the same time.
//
// Action buttons are DOM elements layered above the canvas, so their pointer
// events never reach this listener — no hit-testing needed here.
export interface TouchState {
  moveX: number;
  moveY: number;
  lookDx: number;
  lookDy: number;
  joyActive: boolean;
  joyOx: number;
  joyOy: number;
  joyKx: number;
  joyKy: number;
  sprint: boolean;
}

const JOY_RADIUS = 54;      // css px of full deflection
const SPRINT_AT = 0.86;     // deflection past this counts as a sprint
const DEAD_PX = 4;

export class TouchControls {
  readonly state: TouchState = {
    moveX: 0, moveY: 0, lookDx: 0, lookDy: 0,
    joyActive: false, joyOx: 0, joyOy: 0, joyKx: 0, joyKy: 0, sprint: false,
  };

  private canvas: HTMLCanvasElement;
  private movePid: number | null = null;
  private lookPid: number | null = null;
  private lookLast = { x: 0, y: 0 };
  onChange: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener("pointerdown", this.down, { passive: false });
    canvas.addEventListener("pointermove", this.move, { passive: false });
    canvas.addEventListener("pointerup", this.up, { passive: false });
    canvas.addEventListener("pointercancel", this.up, { passive: false });
    canvas.style.touchAction = "none";
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < rect.width * 0.5 && this.movePid === null) {
      this.movePid = e.pointerId;
      const s = this.state;
      s.joyActive = true;
      s.joyOx = x; s.joyOy = y;
      s.joyKx = x; s.joyKy = y;
      s.moveX = 0; s.moveY = 0; s.sprint = false;
      this.onChange();
    } else if (this.lookPid === null) {
      this.lookPid = e.pointerId;
      this.lookLast = { x, y };
    }
    e.preventDefault();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const s = this.state;

    if (e.pointerId === this.movePid) {
      let dx = x - s.joyOx;
      let dy = y - s.joyOy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_RADIUS) {
        // Drag the origin along so the stick never feels stuck at its limit.
        s.joyOx += (dx / len) * (len - JOY_RADIUS);
        s.joyOy += (dy / len) * (len - JOY_RADIUS);
        dx = (dx / len) * JOY_RADIUS;
        dy = (dy / len) * JOY_RADIUS;
      }
      s.joyKx = s.joyOx + dx;
      s.joyKy = s.joyOy + dy;
      const mag = Math.hypot(dx, dy);
      if (mag < DEAD_PX) {
        s.moveX = 0; s.moveY = 0; s.sprint = false;
      } else {
        s.moveX = dx / JOY_RADIUS;
        s.moveY = -dy / JOY_RADIUS; // screen down is world backward
        s.sprint = mag / JOY_RADIUS >= SPRINT_AT;
      }
      this.onChange();
      e.preventDefault();
    } else if (e.pointerId === this.lookPid) {
      s.lookDx += x - this.lookLast.x;
      s.lookDy += y - this.lookLast.y;
      this.lookLast = { x, y };
      e.preventDefault();
    }
  };

  private up = (e: PointerEvent) => {
    const s = this.state;
    if (e.pointerId === this.movePid) {
      this.movePid = null;
      s.joyActive = false;
      s.moveX = 0; s.moveY = 0; s.sprint = false;
      this.onChange();
    } else if (e.pointerId === this.lookPid) {
      this.lookPid = null;
    }
  };

  /** Read and clear the accumulated look delta. */
  consumeLook(): { dx: number; dy: number } {
    const d = { dx: this.state.lookDx, dy: this.state.lookDy };
    this.state.lookDx = 0;
    this.state.lookDy = 0;
    return d;
  }

  dispose() {
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointercancel", this.up);
  }
}
