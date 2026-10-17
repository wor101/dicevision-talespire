# DiceVision Talespire Symbiote - Development Guide

## Overview

This repository contains a Talespire symbiote that connects to DiceVision's WebSocket bridge and displays physical dice roll results in Talespire's native dice tray.

## Architecture

```
DiceVision Camera → Backend → WebSocket Bridge → This Symbiote → TS.dice.sendDiceResult()
                              /api/bridge/{code}
```

The symbiote:
1. Connects to `wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}`
2. Receives `roll` messages with dice data
3. Converts to Talespire format
4. Calls `TS.dice.sendDiceResult()` to display in dice tray
5. Optionally sends chat announcement via `TS.chat.send()`

## Reference Links

### Talespire Symbiote Documentation
| Resource | URL |
|----------|-----|
| Main Docs | https://symbiote-docs.talespire.com/ |
| API Reference (v0.1) | https://symbiote-docs.talespire.com/api_doc_v0_1.md.html |
| Manifest Reference (v1) | https://symbiote-docs.talespire.com/manifest_doc_v1.html |
| Getting Started, Extras (theme/fonts/icons), lifetime, FAQ | Sections of the main docs page |
| Example Symbiotes (GitHub) | https://github.com/Bouncyrock/symbiotes-examples |

### DiceVision Backend
| Resource | URL |
|----------|-----|
| WebSocket Bridge Endpoint | `wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}` |

## Project Structure

```
dicevision-talespire/
├── symbiote/                 # The symbiote (installed in Talespire)
│   ├── manifest.json         # Symbiote configuration
│   ├── index.html            # Main entry point
│   ├── app.js                # WebSocket client + Talespire integration
│   ├── app.css               # Styling (uses TS theme variables)
│   ├── icons/
│   │   └── icon_64.png       # Required icon (64x64)
│   └── readme.md             # Description shown in Talespire
├── docs/
│   └── SETUP.md              # Detailed setup instructions
├── README.md                 # User documentation
├── CLAUDE.md                 # This file
├── LICENSE                   # MIT License
└── .gitignore
```

## WebSocket Protocol

### Connection
```
wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}
```

### Session Code Format

- **Length**: 8 characters
- **Character set**: `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (excludes ambiguous 0/O/1/I/L)
- **Display format**: `XKRM-4N7B` (dash after 4th character for readability)
- **Normalization**: Uppercase, strip dashes before use (e.g., `xkrm-4n7b` → `XKRM4N7B`)
- **DB constraint**: `^[A-Z2-9]{8}$`

### Messages Received (Server → Client)

```javascript
// Connection confirmed
{ "type": "connected", "session_code": "XKRM4N7B", "waiting": false, "waiting_apps": [] }

// Dice roll result
{
  "type": "roll",
  "session_code": "XKRM4N7B",
  "data": {
    "dice": [
      {"type": "d20", "value": 15, "face": "15", "readable": true},
      {"type": "d6", "value": 4, "face": "pip_4", "readable": true},
      {"type": "d8", "value": -1, "face": "-1", "readable": false}
    ],
    "total": 19,
    "roll_id": "uuid",
    "timestamp": "2026-01-11T12:05:30.123Z"
  }
}

// Recognition found no dice while we were waiting (waiting state unchanged; ignored today)
{ "type": "no_dice", "session_code": "XKRM4N7B" }

// Keepalive response
{ "type": "pong" }

// Error
{ "type": "error", "message": "Invalid or expired session code" }
```

Each die is the shared VTT format (dice-vision PR #420, `docs/integrations/VTT.md` there):

- `face`: the face as printed: `"7"`, `"00"`, `"30"`, `"pip_4"` (pip d6), `"-1"` when unread.
- `value`: its number (pips as dots, `"00"` and `"0"` both 0), -1 when unreadable. This goes to the dice tray.
- `readable`: `false` when the camera couldn't read the die.

`readDice()` in `app.js` reads every roll on arrival. Older servers sent `{type, value}` only, so `face` and `readable` are worked out from `value` then; malformed entries read as unreadable `d?` dice. A roll with an unreadable die, or no dice, isn't sent to the tray: `handleRoll` calls `onUnusableRoll` (the panel shows "Couldn't read 1d8. Roll again; still waiting." and a "not sent" entry in Recent Rolls) and registers waiting again in Roll Once and continuous mode, since the server drops our waiting flag with each roll. Chat announcements and Recent Rolls show faces as printed (`1d10(00)`).

### Messages Sent (Client → Server)

```javascript
// Register as waiting for rolls (sent on connect and after each roll received)
{ "type": "waiting", "app_id": "talespire" }

// Keepalive ping (every 30 seconds)
{ "type": "ping" }
```

## Talespire API Reference

### Dice Results

```javascript
// Send dice result to tray
await TS.dice.sendDiceResult([resultGroup]);

// rollResult - individual dice (can have multiple results for same type)
// kind must be the die type: 'd4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'
// results must be a plain array of integers, NOT objects with {value}
{
  name: "Physical Dice",
  result: {
    kind: "d20",      // Die type
    results: [15, 12] // Plain array of integers (e.g., 2d20 rolled 15 and 12)
  }
}

// rollResultsOperation - combining different dice types
// IMPORTANT: Use 'operator' (not 'kind') with values '+' or '-'
// Operators require exactly 2 operands; nest for 3+ dice types
{
  name: "Physical Dice",
  result: {
    operator: "+",    // NOT 'kind: "sum"' - that causes incorrectTypes error
    operands: [
      { kind: "d20", results: [15] },
      { kind: "d6", results: [4, 3] }
    ]
  }
}

// Three or more dice types - nest operators (each has exactly 2 operands)
{
  name: "Physical Dice",
  result: {
    operator: "+",
    operands: [
      {
        operator: "+",
        operands: [
          { kind: "d20", results: [15] },
          { kind: "d6", results: [4] }
        ]
      },
      { kind: "d4", results: [3] }
    ]
  }
}
```

**API Reference:** https://symbiote-docs.talespire.com/api_doc_v0_1.md.html

### Chat Messages

```javascript
// Send to everyone
await TS.chat.send("Physical Dice: 1d20(15) = 15", "board");

// Send to GM only: the keyword is "gms" (all GMs). "gm" isn't a keyword
// (it's read as a player name), which is why GM-only announcements before
// 1.1.0 never arrived. Other keywords: "campaign", or a player id.
await TS.chat.send("Physical Dice: 1d20(15) = 15", "gms");
```

Messages are cut at 400 characters. The tray result itself is always public: `sendDiceResult` has no hidden option, so "GM only" applies to the chat announcement.

### Notifications

```javascript
// Only while the panel is hidden (the panel's own message is invisible then)
if (!(await TS.symbiote.getIfThisSymbioteIsVisible())) {
  await TS.symbiote.sendNotification("DiceVision", "Couldn't read 1d8. Roll again; still waiting.");
}
```

`sendNotification` needs `api.interop.id` in the manifest (else `symbioteManifestMissingInteropId`); clicking it opens the panel. `notifyOutsidePanel()` falls back to a chat whisper to the player (`players.whoAmI()` → `chat.send(msg, me.id)`). It's used for unreadable / empty rolls, once until a roll goes through.

### Local Storage

```javascript
// ONE blob per symbiote and campaign: no keys, and no removeBlob
await TS.localStorage.campaign.setBlob(JSON.stringify(state));
const state = JSON.parse(await TS.localStorage.campaign.getBlob());
await TS.localStorage.campaign.deleteBlob();
```

`campaignStore` in `app.js` keeps `{ sessionCode, options }` as that one JSON blob and queues writes, so saving the code and the options together can't lose one. Versions before 1.1.0 called `setBlob(key, value)`, which saved the key's name as the whole blob (so the session code never persisted); `parseStoredState` reads such a blob as nothing saved. A blob is limited to 5MB.

## Development Workflow

### Local Testing

1. Start DiceVision backend locally:
   ```bash
   cd /path/to/dice-vision/backend
   source ../dice-vision-env/bin/activate
   python -m uvicorn app.main:app --reload
   ```

2. Modify `CONFIG.WS_URL` in `app.js`:
   ```javascript
   WS_URL: 'ws://localhost:8000/api/bridge',
   ```

3. Copy symbiote to Talespire:
   ```bash
   cp -r symbiote "%AppData%/../LocalLow/BouncyRock Entertainment/TaleSpire/Symbiotes/DiceVision/"
   ```

4. Launch Talespire and test

### Debug Logging

All logs use `[DiceVision]` prefix:
```javascript
console.log('[DiceVision] Message received:', msg);
```

View logs in browser dev tools (Talespire uses Chromium).

## CSS Variables

The `colorStyles` extra injects these variables (the only ones TaleSpire documents; each use in `app.css` keeps a fallback color). Before 1.1.0 the CSS used made-up names (`--ts-accent`, `--ts-text`, …), so the theme never applied.

```css
--ts-color-primary, --ts-color-secondary, --ts-color-danger
--ts-background-primary, --ts-background-secondary, --ts-background-tertiary
--ts-accent-primary, --ts-accent-hover, --ts-accent-background
--ts-button-background, --ts-button-hover
--ts-accessibility-border, --ts-accessibility-focus
--ts-link, --ts-link-hover
```

## Manifest

`symbiote/manifest.json` uses only the fields in the manifest v1 docs: `summary`, `descriptionFilePath` (`/readme.md`), `about`, `icons.64x64`, `api.interop.id` (a fixed UUID, needed for notifications; don't change it), `environment.webViewBackgroundColor` (no white flash while loading), `capabilities: ["runInBackground"]` (rolls must land while the panel is closed), and `extras: ["colorStyles"]`. Bump `version` with each release.

## Key Files Reference

### Main DiceVision Repo (for context)

| File | Purpose |
|------|---------|
| `backend/app/routers/bridge.py` | WebSocket endpoint implementation |
| `backend/app/services/bridge_manager.py` | Connection and state management |
| `docs/CODEX_API_DESIGN.md` | Full protocol documentation |
| `frontend/app/hooks/useBridgeConnection.ts` | Frontend WebSocket client (reference) |

## Testing Checklist

- [ ] Connect with valid session code
- [ ] Connect with invalid session code (error handling)
- [ ] Receive roll → appears in Talespire dice UI
- [ ] Receive roll → appears in chat (if enabled)
- [ ] Session code persists across symbiote reloads
- [ ] Auto-reconnect after connection drop
- [ ] Single die (e.g., 1d20)
- [ ] Multiple dice same type (e.g., 3d6)
- [ ] Multiple dice types (e.g., 1d20 + 2d6)
- [ ] All die types: d4, d6, d8, d10, d12, d20
- [ ] "Symbiote" indicator shows on rolls
- [ ] A die the camera can't read: not sent, panel says which die, the next roll (Roll Once too) is sent
- [ ] Pip d6s show their dots in the tray and chat
- [ ] Session code and options are remembered after closing and reopening the symbiote (auto-connects)
- [ ] Chat announcement set to GM only reaches the GM
- [ ] Panel closed + a die the camera can't read: a TaleSpire notification (once), and clicking it opens the panel
- [ ] Panel colors follow TaleSpire's theme

Unit tests: `npm test` (`tests/app.test.mjs` loads `app.js` into a Node vm with no Talespire or DOM). Run them after any change to `app.js`.

## Deployment

1. Update version in `manifest.json`
2. Create icon if not exists (`icons/icon_64.png`)
3. Test thoroughly in Talespire
4. Create release on GitHub
5. (Optional) Publish to mod.io
