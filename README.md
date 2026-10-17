# DiceVision Talespire Symbiote

A Talespire symbiote that connects physical dice rolls from [DiceVision](https://dicevision.dirtyowlbear.com) to Talespire's native dice tray.

## Features

- **Real-time Integration**: Rolls appear instantly via WebSocket connection
- **Native Dice Tray**: Uses `TS.dice.sendDiceResult()` for proper dice tray display
- **Symbiote Indicator**: GMs can verify rolls came from external source
- **Chat Announcements**: Optional chat messages (to everyone or GM only)
- **Auto-Reconnect**: Handles connection drops with exponential backoff
- **Session Persistence**: Session code and options saved per campaign; reconnects when reopened

## Installation

### Option 1: Download a Release

1. Turn on Symbiotes in TaleSpire's settings, if you haven't.
2. Download [DiceVision.zip](https://github.com/wor101/dicevision-talespire/releases/latest/download/DiceVision.zip) (the latest release).
3. Unzip it into your TaleSpire Symbiotes directory, so you have `Symbiotes/DiceVision/manifest.json`. Open the directory from TaleSpire's Symbiote panel or settings, or go to:
   - **Windows**: `%AppData%/../LocalLow/BouncyRock Entertainment/TaleSpire/Symbiotes/`
4. DiceVision appears in the Symbiote panel.

**Updating:** replace the files in `Symbiotes/DiceVision/` with the new zip's. Keep the hidden `.localStorage` folder there: it holds your saved session code and options.

### Option 2: mod.io (Coming Soon)

The symbiote will be available on mod.io, for one-click installation from TaleSpire's community mod browser.

## Setup

1. **Create a DiceVision Session**
   - Open https://dicevision.dirtyowlbear.com in your browser
   - Log in or create an account
   - Go to Settings → Codex
   - Click "Create Session" to get an 8-character code (e.g., `XKRM-4N7B`)

2. **Connect the Symbiote**
   - Open Talespire and launch the DiceVision symbiote
   - Enter your session code
   - Click "Connect"
   - Status should change to "Connected"

3. **Roll Physical Dice**
   - Position your camera to see your dice
   - Roll dice in front of the camera
   - Results automatically appear in Talespire's dice tray

## Options

- **Announce in chat**: Send roll results to chat (default: on)
- **Chat announcement to**: Choose "Board (everyone)" or "GM only". The dice tray has no GM-only option; this only sets who gets the chat line
- **Roll label**: Customize the name shown for rolls (default: "Physical Dice")

## Supported Dice

- d4, d6, d8, d10, d12, d20
- Multiple dice of different types in a single roll
- Mixed dice (e.g., 1d20 + 2d6)
- Pip d6s (dots) as well as numbered dice

If the camera couldn't read a die, or read a value the die can't show (like a d4 of 12), the roll isn't sent to the dice tray: the panel says which die, and in Roll Once or continuous mode the symbiote keeps waiting. Roll again in view of the camera. With the panel closed (or another symbiote in front), a TaleSpire notification tells you instead, once until a roll goes through; if notifications fail, you get a chat whisper. If the dice tray rejects a roll, the panel says so (with the reason) and Recent Rolls marks it.

The session code and options are saved per campaign, and the symbiote reconnects when you reopen it.

## Troubleshooting

### "Invalid or expired session code"
- Create a new session in DiceVision Settings → Codex
- Sessions expire after 24 hours of inactivity

### Connection keeps dropping
- Check your internet connection
- The symbiote will auto-reconnect up to 5 times
- If issues persist, try disconnecting and reconnecting manually

### Rolls not appearing in dice tray
- Verify the symbiote shows "Connected" status
- Check that DiceVision is detecting dice correctly
- Look for errors in the browser console (F12 in the DiceVision web app)

### Rolls show as "Symbiote" source
- This is expected! Talespire marks external dice results with a "Symbiote" indicator
- GMs can use this to verify physical dice were used

## Development

See [CLAUDE.md](CLAUDE.md) for development documentation. `npm test` runs the unit tests and `npm run lint` runs ESLint (run `npm ci` first); CI runs both on every PR.

### Testing Locally

1. Start the DiceVision backend locally (see main DiceVision repo)
2. Modify `CONFIG.WS_URL` in `symbiote/app.js` to use `ws://localhost:8000/api/bridge`
3. Copy the symbiote folder to Talespire
4. Test with the DiceVision frontend

## License

MIT License - see [LICENSE](LICENSE)

## Related Projects

- [DiceVision](https://github.com/wor101/dice-vision) - Physical dice recognition using computer vision
- [Talespire Symbiote API](https://symbiote-docs.talespire.com/) - Official documentation
