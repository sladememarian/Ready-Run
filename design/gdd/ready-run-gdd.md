# Ready-Run — Game Design Document

## Logline
You are a Sounder, alone in a listening station a kilometre underground. The station was built
to listen. Something answered. It hunts by sound — and every task you must complete makes noise.

## Lore: The Hollow Choir

Deep Listening Post **Kestrel-9** was sunk into the Carpathian shield in 1974 to detect
underground weapons tests. For eleven years it heard nothing but the earth settling.

In 1985 the array recorded a fourteen-minute signal from **below** the array — deeper than any
drilling had ever reached. It was not a detonation. It was structured. Repeating. The technicians
called it the Choir because it had many voices and they were not in agreement.

Command ordered the array driven in reverse — to broadcast the signal back down. The logic was
that a reply would prove the signal artificial.

The Choir understood the reply as an *address*.

What came up the shafts has no eyes; there is nothing to see where it comes from. It navigates
the way the station did: by listening. The last Sounder on duty wrote a protocol on the wall in
grease pencil, and it is the only thing in Kestrel-9 that still works:

> **READY — RUN**
> Stand ready. Make no sound. When it commits, run.

You have come down to shut the array off. To do that you must align three signal relays. Each
relay, while aligning, screams.

## The Antagonist: The Listener

Blind, elongated, pale — a body that is mostly ear. Broad cartilaginous frills fan from the skull
and track independently toward sound. It does not see the flashlight. It hears the click when you
switch it on.

**States**
| State | Behaviour | Player tell |
|---|---|---|
| DORMANT | Slow patrol, frills furled | Distant wet clicking |
| ALERT | Moves to last heard position | Clicking quickens, frills open |
| HUNT | Direct fast pursuit | A call — dissonant, rising |
| SEARCH | Circles last known position, then decays to DORMANT | Irregular scraping |

It is never despawned and never scripted. It is always somewhere, always listening.

## Core Mechanic: Noise Is Visibility

The player has no health bar. The resource is **silence**.

| Action | Noise |
|---|---|
| Stand still | 0 |
| Crouch-walk | 0.15 |
| Walk | 0.45 |
| Sprint | 1.0 |
| Flashlight toggle | 0.6 spike |
| Relay alignment | 0.9 sustained, at the relay's position |

Noise emits as a ping: position + intensity. The Listener hears pings attenuated by distance.
This creates the intended loop — objectives are loud, so progress is inherently dangerous.

**The trade:** the flashlight makes the level readable but its toggle is loud. Moving dark is
silent but you will walk into the Listener.

## Missions

1. **Descent** — reach the relay floor. Teaches movement and the first distant clicking.
2. **Align Relay ALPHA / BETA / GAMMA** — hold each relay for ~7s. It shrieks. The Listener
   comes. Aligning is deliberately impossible to do while safe — the player must learn to bait
   the Listener away, start the alignment, and break line-of-travel.
3. **The Lift** — with all three aligned, the lift powers. Reaching it ends the run.

Objectives may be completed in any order. Difficulty is emergent: the Listener's search
position persists, so a botched relay poisons that region of the map for minutes.

## Audio Direction

All audio is synthesized at runtime (WebAudio) — no sample assets.

- **Ambient drone**: two detuned sub-oscillators + filtered noise. Never silent; silence would
  make the player's own noise unreadable.
- **Heartbeat**: rate and gain scale with Listener proximity. This is the primary threat readout,
  not the HUD.
- **The call**: swept dissonant pair + noise burst on entry to HUNT.
- **Relay shriek**: rising sawtooth cluster while aligning.

## Visual Direction

Near-black. The flashlight cone is the only meaningful light. Wet concrete, corroded steel,
sodium-orange emergency strips that light nothing.

Constraints per `CLAUDE.md`: one shadow-casting light (the flashlight), instanced wall geometry,
pooled particles, single composited post pass (grain + vignette + aberration + desaturation).
