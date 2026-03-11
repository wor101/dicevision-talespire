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
| Manifest Reference (v1) | https://symbiote-docs.talespire.com/manifest_v1.md.html |
| Getting Started | https://symbiote-docs.talespire.com/getting_started.md.html |
| Extras (Themes/Fonts/Icons) | https://symbiote-docs.talespire.com/extras.md.html |
| FAQ | https://symbiote-docs.talespire.com/faq.md.html |
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
    "dice": [{"type": "d20", "value": 15}, {"type": "d6", "value": 4}],
    "total": 19,
    "roll_id": "uuid",
    "timestamp": "2026-01-11T12:05:30.123Z"
  }
}

// Keepalive response
{ "type": "pong" }

// Error
{ "type": "error", "message": "Invalid or expired session code" }
```

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

// Send to GM only
await TS.chat.send("Physical Dice: 1d20(15) = 15", "gm");
```

### Local Storage

```javascript
// Save per campaign
await TS.localStorage.campaign.setBlob("key", "value");
await TS.localStorage.campaign.getBlob("key");
await TS.localStorage.campaign.removeBlob("key");
```

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

The symbiote uses Talespire CSS variables for theme integration:

```css
--ts-background        /* Main background */
--ts-background-alt    /* Panel background */
--ts-text              /* Normal text */
--ts-text-bright       /* Emphasized text */
--ts-text-muted        /* Secondary text */
--ts-border            /* Border color */
--ts-accent            /* Primary accent (buttons) */
--ts-accent-hover      /* Accent hover state */
--ts-font-family       /* System font */
--ts-font-size         /* Base font size */
--ts-input-background  /* Input field background */
```

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

## Deployment

1. Update version in `manifest.json`
2. Create icon if not exists (`icons/icon_64.png`)
3. Test thoroughly in Talespire
4. Create release on GitHub
5. (Optional) Publish to mod.io
