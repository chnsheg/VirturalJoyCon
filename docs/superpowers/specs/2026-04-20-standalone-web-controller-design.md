# JoyCon Standalone Web Controller Design

## Summary

This design converts the current project from a Python-hosted web UI into a split deployment model:

- A standalone static web controller is deployed independently on any HTTP server.
- The Python host keeps only control endpoints for WebSocket and HTTP input submission.
- The web controller stores a user-selected `ip:port` locally and reconnects to that target automatically on future launches.
- The host target editor stays out of the way during gameplay by using a low-visibility edge handle that reveals a drawer only when needed.

The PWA requirement was removed during design review. This scope covers a standalone web app only.

## Goals

- Keep gameplay UI focused on controller input with no persistent host setup panel visible during normal use.
- Allow the front-end to run on a different machine than the Python host.
- Let users change the target host rarely, save it once, and reuse it automatically.
- Preserve the current low-latency input flow over WebSocket with HTTP fallback.
- Make host deployment practical by explicitly covering Windows firewall and local port exposure.

## Non-Goals

- No PWA install, manifest, service worker, or offline support.
- No multi-host switching UI, host history, or profile management.
- No authentication or Internet-facing hardening in this iteration.
- No redesign of the controller layout beyond the hidden host settings affordance.
- No removal of UDP support from the codebase if it is still useful for compatibility, but UDP is not part of the primary web control path.

## Current Project Context

The repository currently contains:

- A Python `aiohttp` web host in `pc_host/web_host.py`
- The controller front-end under `pc_host/web/`
- Front-end logic in `pc_host/web/app.mjs`, `pc_host/web/input-core.mjs`, and `pc_host/web/layout-core.mjs`
- Existing front-end unit tests in `pc_host/web/tests/`
- A Windows firewall helper script in `pc_host/scripts/fix_network_access.ps1`

Today the front-end assumes the control page is served by the same host that exposes `/ws` and `/input`. The design removes that assumption.

## Architecture

### Deployment Model

The system will be split into two independently deployable pieces:

1. A standalone static front-end bundle served from any HTTP file host.
2. A Python control host that exposes only API endpoints used by the front-end.

The front-end must no longer derive its target from `location.host`. Instead, it reads a saved `ip:port` value from local storage and builds remote endpoints explicitly.

### Runtime Data Flow

1. The user opens the standalone web controller.
2. The front-end reads the saved host target from `localStorage`.
3. If a saved value exists, the front-end builds:
   - `ws://<ip:port>/ws`
   - `http://<ip:port>/input`
4. The front-end attempts a WebSocket connection first.
5. If the WebSocket is unavailable, the front-end continues using HTTP fallback for input packets.
6. If the user edits the host target in the hidden drawer, the front-end saves the new value, tears down the old connection, and immediately reconnects to the new target.
7. If the save-and-reconnect flow succeeds, the drawer closes automatically.

## Front-End UX Design

### Hidden Host Settings Entry

The host configuration entry is intentionally low-emphasis:

- A narrow edge handle is placed on the right edge of the screen.
- Default width is approximately `6px` to `8px`.
- Default height is approximately `52px` to `64px`.
- Default opacity stays low enough to avoid drawing the eye during gameplay.
- On touch, hover, or drag start, the handle becomes visually clearer.

This keeps the control surface unobstructed while still leaving a discoverable path to host configuration.

### Drawer Behavior

The drawer slides in from the right side and contains only the minimum needed controls:

- One `ip:port` input field
- One save/connect action
- One compact status or validation line

Expected behavior:

- Closed by default
- Opens by dragging or tapping the edge handle
- Uses a narrow panel so it only briefly overlaps the right-side controls while being edited
- Saves the host value to local storage
- Immediately reconnects after save
- Automatically hides after a successful save and reconnect trigger
- Stays open when validation fails or when the address is unreachable

### First-Run Discoverability

When no host has been saved yet:

- The top status text shows that no host is configured.
- The edge handle may do a minimal one-time hint animation.
- The hint must stop quickly and not repeat continuously.

### Status Visibility

The always-visible status layer remains subtle and lightweight. It should expose:

- Current host target
- Connection mode and state such as `connecting`, `connected`, `HTTP fallback`, or `connect failed`
- Existing slot and latency indicators where they still fit naturally

The drawer is not used as a permanent status area.

## Connection and Validation Rules

### Saved Host Format

For the first iteration, the input format is intentionally narrow:

- Accept `IPv4:port`
- Reject empty values
- Reject malformed IPv4 addresses
- Reject ports outside the valid numeric range

This avoids adding parsing ambiguity before the core split-deployment model is stable.

### Connection Lifecycle

Saving a new host target performs these steps:

1. Normalize and validate the input.
2. Save the canonical `ip:port` string locally.
3. Close the previous socket if one exists.
4. Rebuild remote endpoint URLs.
5. Attempt a new connection.
6. Update the visible status text.
7. Auto-close the drawer once local validation passes, persistence succeeds, and the reconnect attempt has been started.

If a subsequent connection attempt fails, the saved host remains intact and the user can reopen the drawer to correct it.

## Back-End API Design

### Endpoint Scope

The Python host should keep only the remote control endpoints required by the standalone front-end:

- `GET /ws`
- `POST /input`
- `OPTIONS /input`

The host should stop acting as the web UI file server in the primary deployment path.

### Cross-Origin Support

Because the front-end is served from a different origin, the Python host must explicitly support cross-origin browser requests.

For `POST /input` and `OPTIONS /input`, the host should return the headers required for the standalone front-end to submit JSON packets from another origin. The design target is permissive LAN use rather than strict origin allowlists.

For WebSocket connections, the host should tolerate browser `Origin` headers from the standalone front-end instead of assuming same-origin delivery.

### Error Handling

The host should continue returning explicit machine-readable failure reasons where possible, including:

- `bad_json`
- `bad_packet`
- `device_pool_full`

The front-end should map these to compact user-facing status messages without introducing modal interruptions.

## Deployment and Port Exposure

### Required Reachability

For the standalone web controller path, the critical reachable port is the Python host's HTTP port because it carries:

- The WebSocket endpoint on the same TCP port
- The HTTP fallback endpoint on the same TCP port

This means the main deployment success criterion is:

- The host must listen on a LAN-reachable address, typically `0.0.0.0`
- The selected TCP port must be open through Windows Firewall

### UDP Positioning

UDP support may remain in the project for compatibility, but it is not part of the primary standalone web controller flow. Documentation and output should clearly separate:

- TCP `http-port`: required for the standalone web controller
- UDP `udp-port`: optional unless another client path depends on it

### Windows Firewall Helper

The existing PowerShell helper script should be retained and aligned with the new deployment model. It should continue helping users:

- Set the WLAN profile to `Private` when possible
- Open the required TCP port for the Python host
- Optionally open UDP only when relevant
- Print candidate LAN IP addresses
- Show basic listening status for the configured port

### Startup Guidance

The Python host's startup output and README should make the deployment chain obvious:

1. Start the Python host with a LAN-reachable bind address.
2. If other devices cannot connect, run the firewall helper script as administrator.
3. Read the printed LAN IP and TCP port.
4. Enter that `ip:port` into the standalone front-end drawer.

## Testing Strategy

### Front-End Automated Tests

Add or update front-end tests for:

- Host string parsing and validation
- Canonical remote URL generation from `ip:port`
- Drawer open and close state transitions
- Save action auto-hiding the drawer on success
- Loading and overwriting persisted host configuration

### Front-End Manual Verification

Manual checks should confirm:

- The edge handle is unobtrusive during normal play
- The drawer is still discoverable
- The drawer does not block important controls when closed
- Saving a valid host reconnects immediately
- Invalid host input keeps the drawer open and shows a small error
- Existing controller behavior still feels unchanged during normal gameplay

### Back-End Tests

Add or update server tests for:

- `OPTIONS /input` behavior
- Cross-origin headers on `POST /input`
- Existing `/ws` and `/input` behavior not regressing
- Startup and documentation flow reflecting the new deployment model

## Risks and Constraints

- Browsers will not allow direct browser-to-LAN communication if local network policy, firewall settings, or device isolation block traffic.
- Split deployment introduces cross-origin behavior that does not exist in the current same-origin setup.
- A drawer that is too visible becomes distracting; a drawer handle that is too faint becomes undiscoverable.
- Restricting the first version to `IPv4:port` avoids ambiguity but leaves out hostnames and IPv6 for now.

## Open Design Decisions Resolved In This Spec

The following decisions were made during brainstorming:

- No PWA scope
- Standalone static front-end deployment
- Python host only exposes control endpoints
- Host target is saved rarely and reused automatically
- Hidden right-edge drawer with a low-visibility handle
- Save should auto-hide the drawer
- HTTP deployment is acceptable
- Port exposure and firewall configuration must be part of the supported deployment path

## Success Criteria

The design is successful when:

- The front-end can be hosted independently of the Python machine.
- A user can enter `ip:port` once and reconnect automatically on future visits.
- The host settings affordance stays visually unobtrusive during gameplay.
- The Python host is documented and instrumented well enough that users can diagnose local port reachability issues.
- Existing controller responsiveness and fallback behavior are preserved.
