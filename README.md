# DiceVision Talespire Symbiote

A Talespire symbiote that connects physical dice rolls from [DiceVision](https://dicevision.dirtyowlbear.com) to Talespire's native dice tray.

## Features

- **Real-time Integration**: Rolls appear instantly via WebSocket connection
- **Native Dice Tray**: Uses `TS.dice.sendDiceResult()` for proper dice tray display
- **Symbiote Indicator**: GMs can verify rolls came from external source
- **Chat Announcements**: Optional chat messages (to everyone or GM only)
- **Auto-Reconnect**: Handles connection drops with exponential backoff
- **Session Persistence**: Session code saved per campaign

## Installation

### Option 1: Manual Installation

1. Download or clone this repository
2. Copy the `symbiote/` folder to your Talespire Symbiotes directory:
   - **Windows**: `%AppData%/../LocalLow/BouncyRock Entertainment/TaleSpire/Symbiotes/`
3. Rename the folder to `DiceVision` (optional, for cleaner display)
4. Launch Talespire - the symbiote should appear in the symbiote panel

### Option 2: mod.io (Coming Soon)

The symbiote will be available on mod.io for one-click installation.

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
- **Send rolls to**: Choose "Board (everyone)" or "GM only"
- **Roll label**: Customize the name shown for rolls (default: "Physical Dice")

## Supported Dice

- d4, d6, d8, d10, d12, d20
- Multiple dice of different types in a single roll
- Mixed dice (e.g., 1d20 + 2d6)

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

See [CLAUDE.md](CLAUDE.md) for development documentation.

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
