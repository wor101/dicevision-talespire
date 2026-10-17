# DiceVision Talespire Symbiote - Setup Guide

This guide walks you through setting up the DiceVision symbiote for Talespire.

## Prerequisites

- Talespire (Steam or standalone)
- A web browser with webcam access
- Physical dice

## Step 1: Install the Symbiote

### Manual Installation

1. Download the latest release from GitHub
2. Extract the ZIP file
3. Copy the `symbiote` folder to your Talespire Symbiotes directory:

   **Windows:**
   ```
   %AppData%\..\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\
   ```

   Or navigate to:
   ```
   C:\Users\<YourUsername>\AppData\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\
   ```

4. Rename the folder from `symbiote` to `DiceVision` for a cleaner display name

5. Your folder structure should look like:
   ```
   Symbiotes/
   └── DiceVision/
       ├── manifest.json
       ├── index.html
       ├── app.js
       ├── app.css
       ├── readme.md
       └── icons/
           └── icon_64.png
   ```

6. Launch or restart Talespire

## Step 2: Create a DiceVision Session

1. Open https://dicevision.dirtyowlbear.com in your web browser

2. Log in or create an account (required for session management)

3. Allow camera access when prompted

4. Go to **Settings** (gear icon in the top-right)

5. Navigate to the **Codex** tab

6. Click **Create Session**

7. Copy the 8-character session code (e.g., `XKRM-4N7B`)

## Step 3: Connect the Symbiote

1. In Talespire, open the Symbiotes panel (default: `F6` or click the puzzle piece icon)

2. Find and click on **DiceVision - Physical Dice Integration**

3. Enter your session code in the input field

4. Click **Connect**

5. The status should change to **Connected** (green dot)

## Step 4: Configure Options

While connected, you can adjust these settings:

| Option | Description |
|--------|-------------|
| **Announce in chat** | Send roll results to the chat window |
| **Chat announcement to** | Choose "Board (everyone)" or "GM only". The dice tray result is always visible to everyone; this only sets who gets the chat line |
| **Roll label** | Customize the name shown (default: "Physical Dice") |

Settings are saved per campaign.

## Step 5: Roll Physical Dice

1. Position your camera to see your dice clearly
   - Good lighting is important
   - Plain, contrasting background works best

2. Roll your dice in view of the camera

3. DiceVision will detect the roll and send it to Talespire

4. The roll appears in:
   - Talespire's dice tray (bottom of screen)
   - Chat window (if enabled)
   - The symbiote's "Recent Rolls" list

## Verification

### For GMs

Rolls from the symbiote will show a **"Symbiote"** indicator in the dice tray. This confirms the roll came from an external source (DiceVision) rather than Talespire's built-in roller.

### For Players

Your physical dice rolls will appear just like normal Talespire rolls, but with the roll name you configured (e.g., "Physical Dice").

## Troubleshooting

### Symbiote Not Appearing

1. Verify the folder is in the correct location
2. Check that `manifest.json` exists in the symbiote folder
3. Restart Talespire completely

### "Invalid or Expired Session"

- Sessions expire after 24 hours of inactivity
- Create a new session in DiceVision Settings → Codex
- Enter the new code in the symbiote

### Connection Drops Frequently

The symbiote automatically reconnects up to 5 times. If issues persist:

1. Check your internet connection
2. Verify DiceVision is still running in your browser
3. Create a new session code
4. Check for firewall/VPN blocking WebSocket connections

### Rolls Not Detected

This is a DiceVision detection issue, not a Talespire issue:

1. Improve lighting conditions
2. Use a plain, contrasting background
3. Keep dice within camera frame
4. Check the DiceVision web interface for detection feedback

### Rolls Appear in DiceVision But Not Talespire

1. Verify symbiote shows "Connected" status
2. Check that DiceVision and Talespire are using the same session code
3. Look for errors in the Recent Rolls list

## Tips

- Keep DiceVision open in a browser tab while playing
- The symbiote runs in the background even when minimized
- Session codes are case-insensitive (XKRM4N7B = xkrm4n7b)
- You can use the same session code for multiple Talespire campaigns

## Getting Help

- Check the [GitHub Issues](https://github.com/wor101/dicevision-talespire/issues)
- Visit the DiceVision website for camera setup tips
- Report bugs with screenshots and the browser console log
