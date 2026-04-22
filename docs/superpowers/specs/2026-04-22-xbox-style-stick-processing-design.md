# Xbox-Style Stick Processing Design

**Goal**
Make the virtual Xbox stick feel stable for both gameplay and menu navigation: a light flick should usually move one menu item, while sustained deflection must still behave like a continuous analog stick for character movement and camera control.

**Constraints**
- Keep the existing virtual Xbox controller protocol and packet format.
- Preserve smooth analog output for gameplay instead of converting the stick into a digital D-pad.
- Follow the most mature and widely used industry pattern: XInput-style radial deadzone and normalization, plus button-like actuation semantics for navigation.
- Respect the current standalone web controller architecture and existing stick sensitivity control.

**Root Cause**
- `AdaptiveStickProcessor` currently computes a filtered vector but sends the unfiltered radial response as the live stick state.
- This means quick touch spikes and release jitter are not actually reduced before the packet is transmitted to the host.
- Menu UIs that interpret stick motion as repeated directional input therefore see several consecutive active frames from a single flick.

**Design**
- Keep the processing split into two layers:
  - Analog layer for continuous stick output sent to the host.
  - Navigation layer for local actuation semantics that shape menu-style flick behavior without destroying analog control.
- The analog layer remains the source of truth for transmitted stick axes.
- The navigation layer does not replace the analog layer; it only decides when the analog layer should snap cleanly into and out of an intentional directional actuation band.

**Analog Layer**
- Start from the pointer-derived normalized vector as today.
- Apply the One Euro filter and use the filtered vector as the actual input to the response pipeline.
- Add release recenter assist:
  - While the pointer magnitude is decreasing toward center, the processed magnitude must not decay slower than the raw magnitude.
  - This keeps outward movement smooth while preventing a sticky tail on release.
- Replace the current effective behavior with an explicit XInput-style radial remap:
  - Clamp to the unit circle.
  - Apply a circular inner deadzone.
  - Re-scale the remaining magnitude back to `[0, 1]`.
  - Apply a small outer deadzone clamp so full travel still reaches `1.0`.
- Keep the response curve after radial remap instead of before it.
- Keep the existing stick sensitivity setting, but have it adjust only the response exponent, not the deadzone gates.

**Touch-Specific Tuning**
- Preserve the XInput algorithm shape, but do not blindly copy the physical Xbox hardware constants.
- The official XInput deadzone constants are designed for noisy mechanical thumbsticks. This project uses a touchscreen surface with different noise characteristics, so the structure of the algorithm should match XInput while the threshold values should be tuned for touch.
- Default touch-oriented targets:
  - Radial deadzone: approximately `0.12` to `0.14`
  - Outer deadzone: approximately `0.02`
  - Response exponent baseline: approximately `1.45`
- The existing sensitivity slider continues mapping to a safe exponent range around that baseline so users can still make the stick slightly softer or quicker without breaking the core feel.

**Navigation Layer**
- Add a directional actuation gate derived from the filtered post-deadzone vector.
- Use hysteresis:
  - Enter directional actuation at a higher threshold.
  - Exit directional actuation at a lower threshold.
- Default actuation targets:
  - Enter threshold: approximately `0.56` to `0.60`
  - Exit threshold: approximately `0.32` to `0.38`
- Use dominant-axis locking:
  - When horizontal and vertical intent are close, keep the previous dominant axis.
  - Only switch axis when the new axis exceeds the previous one by a clear margin.
- Default axis-switch target:
  - Require the new dominant axis to exceed the previous axis by roughly `20%` to `35%`, or by an equivalent small absolute gap, before switching during the same gesture.
- Use fast-release recentering:
  - Outbound motion can be smoothed.
  - Inbound return-to-center should clear actuation quickly so release frames do not linger inside the host menu repeat window.

**Navigation Timing Semantics**
- Mirror the common Xbox menu pattern of `keydown`, `repeat`, and `keyup` semantics rather than raw frame-by-frame amplitude spikes.
- On first crossing the actuation threshold, treat the direction as freshly pressed.
- If the user flicks and returns toward center before the repeat delay expires, the system should produce one clean directional actuation window.
- If the user keeps holding beyond the repeat delay, remain active and allow normal repeat behavior from the target game or UI.
- Default timing targets:
  - Initial repeat delay: approximately `220 ms` to `260 ms`
  - Sustained repeat cadence: approximately `90 ms` to `120 ms`
- These values should be implemented as local gating windows, not as network sleeps or transport throttles.

**Axis and Diagonal Behavior**
- Keep full analog diagonals for gameplay.
- For menu-style interpretation, prefer one cardinal direction at a time.
- A diagonal input near `up-right` should still transmit diagonal analog values to the host, but the navigation gate should expose only the dominant axis until the dominance relationship clearly changes.
- This prevents a small diagonal wobble from producing `up`, then `right`, then `up` again during one gesture.

**Integration Plan**
- Update `pc_host/web/input-core.mjs`:
  - Make `AdaptiveStickProcessor` use filtered vectors for final state.
  - Add explicit radial remap and hysteresis-aware directional actuation helpers.
  - Expose enough intermediate state for tests to verify engage, hold, repeat readiness, and release behavior.
- Update `pc_host/web/app.mjs`:
  - Keep knob display smooth and aligned with processed output.
  - Use the refined processor output as the only live stick state written into packets.
  - Avoid changing transport cadence or packet structure.
- Do not change Python-side stick mapping in this iteration. The host should continue consuming processed analog axes exactly as it does now.

**Testing**
- Add or update web unit tests for:
  - Filtered output being used as the transmitted stick state.
  - A quick flick crossing the actuation threshold and returning to center before the repeat delay.
  - Sustained hold staying active without axis chatter.
  - Release-to-center clearing actuation promptly.
  - Dominant-axis locking under small diagonal jitter.
  - Sensitivity exponent changes preserving full-scale output.
- Keep existing packet snapshot tests passing so protocol compatibility is preserved.
- Add a focused regression test proving the processor no longer returns the raw radial response when filtering and hysteresis would produce a different result.

**Manual Verification**
- In a typical menu, a short upward flick should usually move one item.
- Holding the stick up should still continue moving through the menu after a short pause.
- In gameplay, partial stick deflection should still allow slow walking or slow camera pan.
- Full deflection should still reach full-speed movement.
- Returning the thumb quickly to center should stop movement without a sticky tail.

**Non-Goals**
- No change to the host packet schema.
- No auto-detection of whether a game is currently in menu mode.
- No attempt to synthesize explicit D-pad button presses from the stick in this iteration.
- No backend-side smoothing or timing logic.

**Success Criteria**
- Single flicks no longer commonly cause multiple unintended menu steps.
- Sustained holds still behave like a normal Xbox stick in menus.
- Gameplay analog control remains smooth and continuous.
- The existing sensitivity slider still works, but it no longer makes the stick unpredictably twitchy around center.
