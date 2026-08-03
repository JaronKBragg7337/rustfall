# The prompt to send with the doctrine

Attach `WORLDBUILDING_DOCTRINE_v3` and paste one of the two prompts below.
**The only thing you change is the project line.**

---

## A · Existing project (improve a repo)

```
Attached is my world-building engineering doctrine. Read all of it before you
start — it is how I want the work done, not background reading.

Project: <<<PASTE REPO URL HERE>>>

Clone it if you don't already have it, then get oriented before changing
anything.

Work in this order:

1. Stand up the enforcement layer from Part 9 FIRST — scene report, aperture
   registry, regression diffing, dev handle, headless screenshot harness. Do
   this before content work. If the project already has some of it, fix the
   false-positive rate until the report reads zero, then keep it at zero.
2. Run the Part 2 validation and the Part 6/6B failure laws against what's
   already there. Report what's broken before you fix it.
3. Then improve the world using Part 3B (the form hierarchy) and Part 4
   (materials, albedo sanity, texel density).

Rules I care about:

- Measure before you conclude. Read actual pixel values, bounding boxes,
  uniforms and timings. Don't theorise from a screenshot.
- Verify with the harness, not by asserting. Show me the numbers.
- Tell me plainly what you verified, what you couldn't, and what you skipped.
- If you find a bug I didn't report, say so.
- If something in the doctrine is wrong for this project, say that too and
  explain why — don't silently ignore it.

Ask me anything that would change what you build. Otherwise start.
```

---

## B · New project (build from scratch)

```
Attached is my world-building engineering doctrine. Read all of it before you
start — it is how I want the work done, not background reading.

Project: <<<NAME + ONE-LINE PITCH>>>
Engine: <<<Three.js / Unity / Unreal / Blender>>>

Here's the idea:

<<<DESCRIBE THE GAME OR SCENE>>>

Follow the Part 8 build protocol. Specifically:

1. Ask me what matters before designing — scale, mood, gameplay vs cinematic.
2. Stand up the Part 9 enforcement layer before building content.
3. Design the vocabulary this idea needs; don't reuse someone else's kit.
4. Build to Part 3B — primary, secondary, tertiary, micro. Assembled, not
   booleaned. Real dimensions.
5. Self-validate and report honestly.

Measure before you conclude, and show me the numbers when you verify something.
```

---

## What to expect from a good response

A capable AI given this should, unprompted:

- build the scene report before the content, and keep it at zero issues
- catch placement faults you cannot see in a screenshot
- use real dimensions and a shared detailing kit rather than ad-hoc boxes
- tell you when it deviated from the doctrine and why
- distinguish "I verified this" from "this should work"

If it does none of that, it did not read the document — say so and point it at Part 0.

---

## Keeping this current

The doctrine is versioned. When a project teaches you something that cost real
time, add it to **Part 6B** as a failure law in the same voice: what not to do,
then why, then what it cost. That section is the highest-value part of the
document precisely because every entry was paid for.

Do not delete rules that a given project didn't need. Different worlds need
different parts, and a rule that sat unused in one project is not wrong — keep
both options and note when each applies.
