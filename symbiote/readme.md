# DiceVision - Physical Dice Integration

Connect your physical dice rolls to Talespire! This symbiote receives dice recognition results from DiceVision's camera-based system and displays them in Talespire's dice tray.

## Setup

1. Open DiceVision in your browser (https://dicevision.dirtyowlbear.com)
2. Go to Settings → Codex and create a session
3. Copy the 8-character session code
4. Enter the code in this symbiote and click Connect

## Features

- Real-time dice roll integration via WebSocket
- Rolls appear in Talespire's native dice tray
- Optional chat announcements (to everyone or GM only)
- Automatic reconnection on connection loss
- Session code and options saved per campaign; reconnects when reopened
- Pip d6s count their dots
- If the camera couldn't read a die, or read a value it can't show, the roll isn't sent: the panel (or a TaleSpire notification when the panel is closed) says which die, and it keeps waiting for your reroll

## Supported Dice

d4, d6, d8, d10, d12, d20

## More Info

https://dicevision.dirtyowlbear.com
