/**
 * DiceVision Talespire Symbiote
 *
 * Connects to DiceVision's WebSocket bridge and sends physical dice roll
 * results to Talespire's dice tray using the native TS.dice.sendDiceResult() API.
 */

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // WebSocket endpoint (production)
  WS_URL: 'wss://dicevision.dirtyowlbear.com/api/bridge',

  // Reconnection settings
  RECONNECT_MAX_ATTEMPTS: 5,
  RECONNECT_BASE_DELAY_MS: 1000,
  RECONNECT_MAX_DELAY_MS: 30000,

  // Keepalive ping interval (30 seconds)
  PING_INTERVAL_MS: 30000,

  // Maximum recent rolls to display
  MAX_RECENT_ROLLS: 10,
};

// ============================================================================
// Debug Logging
// ============================================================================

/**
 * Log to both console and Talespire's debug log file.
 * The debug log is written to .debug/log.txt in the symbiote folder.
 * @param {string} message - Message to log
 * @param {*} [data] - Optional data to include
 */
function debugLog(message, data = null) {
  const timestamp = new Date().toISOString();
  const logMsg = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}`
    : `[${timestamp}] ${message}`;

  console.log('[DiceVision]', message, data || '');

  // Write to Talespire debug log if available
  if (typeof TS !== 'undefined' && TS.debug && TS.debug.log) {
    TS.debug.log(logMsg);
  }
}

/**
 * A short reason for a failed TaleSpire API call. Calls reject with objects
 * like { cause: 'notInCampaign' }, which have no `message`.
 * @param {*} err
 * @returns {string}
 */
function describeError(err) {
  if (err && typeof err === 'object') return String(err.cause || err.message || JSON.stringify(err));
  return String(err);
}

// ============================================================================
// Saved State
// ============================================================================

/**
 * Parse the stored blob as a state object. Anything else reads as no saved
 * state. That includes what versions before 1.1.0 left: per the docs
 * setBlob takes one string, so their setBlob(key, value) stored the key name.
 * @param {*} blob
 * @returns {Object}
 */
function parseStoredState(blob) {
  if (blob === undefined || blob === null || blob === '') return {};
  try {
    const state = JSON.parse(blob);
    if (state && typeof state === 'object' && !Array.isArray(state)) return state;
  } catch {
    // fall through
  }
  console.warn('[DiceVision] Saved settings aren\'t a settings object; starting fresh:', blob);
  return {};
}

/**
 * The symbiote's saved state in Talespire's per-campaign storage:
 * { sessionCode, options }. TS.localStorage.campaign holds ONE blob per
 * symbiote and campaign (setBlob(str), getBlob(), deleteBlob(), no keys), so
 * it's all one JSON object.
 * - Writes are queued, so saving the session code and the options at once
 *   can't lose either.
 * - Every write replaces the whole blob, so it's only made on top of a
 *   successful read: a failed read (readFailed, notInCampaign) isn't
 *   remembered as "nothing saved", or the next save would wipe the rest.
 * - The cache only takes a state once it's written.
 * Failures go to onSaveFailed (the panel shows them).
 */
const campaignStore = {
  cache: null,
  loading: null,
  queue: Promise.resolve(),
  /** @type {?function(string): void} Called with a reason when a save fails */
  onSaveFailed: null,
  /** @type {?string} Why the last read failed, if it did */
  lastReadError: null,

  available() {
    return typeof TS !== 'undefined' && !!(TS.localStorage && TS.localStorage.campaign);
  },

  /**
   * The saved state, read once and then cached. Overlapping calls share one
   * read. Never throws.
   * @returns {Promise<?Object>} The state ({} if nothing saved), or null if
   *   storage couldn't be read (not cached, so the next call tries again)
   */
  load() {
    if (this.cache) return Promise.resolve(this.cache);
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const state = this.available() ? parseStoredState(await TS.localStorage.campaign.getBlob()) : {};
          this.lastReadError = null;
          if (!this.cache) this.cache = state;
          return this.cache;
        } catch (err) {
          this.lastReadError = describeError(err);
          console.error('[DiceVision] Failed to load saved settings:', this.lastReadError, err);
          return null;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  },

  /**
   * Merge `patch` into the saved state and write it. Never throws.
   * @param {Object} patch
   * @returns {Promise<boolean>} Whether it was saved
   */
  update(patch) {
    this.queue = this.queue.then(async () => {
      try {
        const current = await this.load();
        if (current === null) {
          throw new Error(`couldn't read the saved settings (${this.lastReadError}), so not overwriting them`);
        }
        const state = { ...current, ...patch };
        if (this.available()) {
          await TS.localStorage.campaign.setBlob(JSON.stringify(state));
        }
        this.cache = state;
        return true;
      } catch (err) {
        const reason = describeError(err);
        console.error('[DiceVision] Failed to save settings:', reason, err);
        if (this.onSaveFailed) this.onSaveFailed(reason);
        return false;
      }
    });
    return this.queue;
  },
};

// ============================================================================
// DiceVision Bridge Client
// ============================================================================

class DiceVisionBridge {
  constructor() {
    this.ws = null;
    this.sessionCode = null;
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.pingInterval = null;
    this.isIntentionalClose = false;

    // Roll mode state
    this.continuousMode = false;     // Auto-re-register after rolls
    this.pendingRollOnce = false;    // Waiting for single roll
    this.isWaiting = false;          // Currently registered as waiting

    // Callbacks
    this.onStatusChange = null;
    this.onRoll = null;
    this.onUnusableRoll = null;      // A roll with an unreadable die, or none
    this.onError = null;
    this.onModeChange = null;        // Callback for UI updates
  }

  /**
   * Connect to the DiceVision bridge with the given session code.
   * @param {string} sessionCode - 8-character session code
   */
  connect(sessionCode) {
    debugLog('Connecting to bridge', { sessionCode: sessionCode });

    if (!sessionCode) {
      this.handleError('Invalid session code');
      this.updateStatus('error');
      return;
    }

    // Normalize session code (uppercase, no dashes)
    this.sessionCode = sessionCode.toUpperCase().replace(/-/g, '');

    if (this.sessionCode.length !== 8) {
      this.handleError('Session code must be 8 characters');
      this.sessionCode = null;
      // Stale code from older 6-char format would otherwise re-fail every load.
      this.clearSavedSession();
      this.updateStatus('error');
      return;
    }

    this.isIntentionalClose = false;
    this.reconnectAttempts = 0;

    this.updateStatus('connecting');
    this.createConnection();
  }

  /**
   * Create the WebSocket connection.
   */
  createConnection() {
    const url = `${CONFIG.WS_URL}/${this.sessionCode}`;
    debugLog('Creating WebSocket connection', { url: url });

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (e) => this.handleMessage(e);
      this.ws.onclose = (e) => this.handleClose(e);
      this.ws.onerror = (e) => this.handleWebSocketError(e);
    } catch (err) {
      this.handleError(`Failed to create connection: ${err.message}`);
    }
  }

  /**
   * Handle WebSocket open event.
   */
  handleOpen() {
    debugLog('WebSocket connected');
    this.reconnectAttempts = 0;
    this.updateStatus('connected');
    this.startPingInterval();

    // Only register as waiting if continuous mode is enabled
    if (this.continuousMode) {
      this.registerWaiting();
    }

    // Notify UI of mode state
    this.notifyModeChange();
  }

  /**
   * Handle incoming WebSocket message.
   * @param {MessageEvent} event
   */
  handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      debugLog('Failed to parse message', event.data);
      return;
    }

    debugLog('Received message', msg);

    switch (msg.type) {
      case 'connected':
        // Initial connection confirmation
        console.log('[DiceVision] Session confirmed:', msg.session_code);
        break;

      case 'roll':
        // Dice roll received
        if (msg.data) {
          this.handleRoll(msg.data);
        }
        break;

      case 'waiting':
        // Codex/other app is waiting for a roll (informational)
        console.log('[DiceVision] App waiting for roll:', msg.app);
        break;

      case 'cancelled':
        // Waiting state was cancelled
        console.log('[DiceVision] Waiting cancelled');
        break;

      case 'pong':
        // Keepalive response (no action needed)
        break;

      case 'error':
        this.handleError(msg.message || 'Unknown error from server');
        if (msg.message && msg.message.includes('Invalid')) {
          // Invalid session - disconnect and clear saved code
          this.disconnect();
          this.clearSavedSession();
        }
        break;

      default:
        console.log('[DiceVision] Unknown message type:', msg.type);
    }
  }

  /**
   * Handle a dice roll from DiceVision.
   * @param {Object} rollData - { dice: [{type, value, face, readable}], total, roll_id, timestamp }
   */
  handleRoll(rollData) {
    console.log('[DiceVision] Roll received:', rollData);
    rollData = { ...rollData, dice: readDice(rollData && rollData.dice) };

    // A die the camera couldn't read would show in the tray as a wrong value,
    // and no dice would send an empty roll: don't send it, and keep waiting
    // for the reroll (Roll Once included). The server dropped our waiting
    // flag when it delivered this roll, so register again.
    const unreadable = rollData.dice.filter(d => !d.readable);
    if (!rollData.dice.length || unreadable.length) {
      if (this.onUnusableRoll) {
        this.onUnusableRoll(rollData, unreadable);
      }
      if (this.pendingRollOnce || this.continuousMode) {
        this.registerWaiting();
      } else {
        this.isWaiting = false;
      }
      this.notifyModeChange();
      return;
    }

    if (this.onRoll) {
      this.onRoll(rollData);
    }

    // Re-register based on current mode
    // (waiting state is cleared after each roll delivery)
    if (this.pendingRollOnce) {
      // Single roll completed - don't re-register
      this.pendingRollOnce = false;
      this.isWaiting = false;
      debugLog('Roll Once completed, returning to idle');
    } else if (this.continuousMode) {
      // Continuous mode - re-register for next roll
      this.registerWaiting();
    } else {
      // Not waiting for more rolls
      this.isWaiting = false;
    }

    // Notify UI of mode change
    this.notifyModeChange();
  }

  /**
   * Handle WebSocket close event.
   * @param {CloseEvent} event
   */
  handleClose(event) {
    debugLog('WebSocket closed', { code: event.code, reason: event.reason });
    this.stopPingInterval();

    if (this.isIntentionalClose) {
      this.updateStatus('disconnected');
      return;
    }

    // Check for invalid session (code 4001)
    if (event.code === 4001) {
      this.handleError('Session invalid or expired');
      this.updateStatus('error');
      this.clearSavedSession();
      return;
    }

    // Attempt reconnection
    if (this.reconnectAttempts < CONFIG.RECONNECT_MAX_ATTEMPTS) {
      this.scheduleReconnect();
    } else {
      this.handleError('Connection lost. Max reconnection attempts reached.');
      this.updateStatus('error');
    }
  }

  /**
   * Handle WebSocket error event.
   * @param {Event} event
   */
  handleWebSocketError(event) {
    debugLog('WebSocket error', event);
    // The close handler will deal with reconnection
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(
      CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      CONFIG.RECONNECT_MAX_DELAY_MS
    );

    console.log(`[DiceVision] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${CONFIG.RECONNECT_MAX_ATTEMPTS})`);
    this.updateStatus('connecting');

    this.reconnectTimeout = setTimeout(() => {
      if (!this.isIntentionalClose && this.sessionCode) {
        this.createConnection();
      }
    }, delay);
  }

  /**
   * Disconnect from the bridge.
   */
  disconnect() {
    this.isIntentionalClose = true;
    this.sessionCode = null;

    // Reset mode state on disconnect
    this.pendingRollOnce = false;
    this.isWaiting = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.stopPingInterval();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.updateStatus('disconnected');
    this.notifyModeChange();
  }

  /**
   * Send a message through the WebSocket.
   * @param {Object} data
   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Start the keepalive ping interval.
   */
  startPingInterval() {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping' });
    }, CONFIG.PING_INTERVAL_MS);
  }

  /**
   * Stop the keepalive ping interval.
   */
  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Update the connection status.
   * @param {'disconnected'|'connecting'|'connected'|'error'} status
   */
  updateStatus(status) {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  /**
   * Handle an error.
   * @param {string} message
   */
  handleError(message) {
    console.error('[DiceVision] Error:', message);
    if (this.onError) {
      this.onError(message);
    }
  }

  /**
   * Clear the saved session code from storage.
   */
  async clearSavedSession() {
    await campaignStore.update({ sessionCode: null });
  }

  /**
   * Check if currently connected.
   * @returns {boolean}
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // ========== Roll Mode Methods ==========

  /**
   * Register as waiting for rolls.
   */
  registerWaiting() {
    if (!this.isConnected()) {
      debugLog('Cannot register waiting - not connected');
      return;
    }

    debugLog('Registering as waiting for rolls');
    this.send({ type: 'waiting', app_id: 'talespire' });
    this.isWaiting = true;
  }

  /**
   * Cancel waiting state.
   */
  cancelWaiting() {
    if (!this.isConnected()) {
      return;
    }

    debugLog('Cancelling waiting state');
    this.send({ type: 'cancel', app_id: 'talespire' });
    this.isWaiting = false;
  }

  /**
   * Enable continuous mode - automatically re-register after each roll.
   */
  enableContinuousMode() {
    debugLog('Enabling continuous mode');
    this.continuousMode = true;
    this.pendingRollOnce = false; // Clear any pending single roll

    if (this.isConnected() && !this.isWaiting) {
      this.registerWaiting();
    }

    this.notifyModeChange();
  }

  /**
   * Disable continuous mode.
   */
  disableContinuousMode() {
    debugLog('Disabling continuous mode');
    this.continuousMode = false;

    // If we're waiting but not for a single roll, cancel
    if (this.isWaiting && !this.pendingRollOnce) {
      this.cancelWaiting();
    }

    this.notifyModeChange();
  }

  /**
   * Request a single roll capture.
   */
  rollOnce() {
    if (!this.isConnected()) {
      this.handleError('Not connected');
      return;
    }

    if (this.isWaiting) {
      debugLog('Already waiting for a roll');
      return;
    }

    debugLog('Roll Once requested');
    this.pendingRollOnce = true;
    this.registerWaiting();
    this.notifyModeChange();
  }

  /**
   * Notify UI of mode state change.
   */
  notifyModeChange() {
    if (this.onModeChange) {
      this.onModeChange(this.continuousMode, this.isWaiting, this.pendingRollOnce);
    }
  }
}

// ============================================================================
// Talespire Integration
// ============================================================================

/**
 * The number a DiceVision face string stands for: "7" -> 7, "00" -> 0,
 * "pip_4" -> 4, "-1" -> -1. null for any other symbol.
 * @param {*} face
 * @returns {number|null}
 */
function faceNumber(face) {
  const s = String(face === undefined || face === null ? '' : face).trim();
  const pips = /^pip_(-?\d+)$/.exec(s);
  if (pips) return Number(pips[1]);
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

/**
 * Read the dice of a DiceVision roll. The server sends each die as
 * {type, value, face, readable} (dice-vision PR #420): face is the face as
 * printed ("7", "00", "pip_4", "-1" when unread), value its number. Older
 * servers sent {type, value} only, so face and readable come from value then.
 * Anything that isn't a die object, or a `readable` other than true (or
 * missing), reads as an unreadable die. A non-array reads as no dice.
 * @param {Array} dice
 * @returns {Array<{type: string, value: number, face: string, readable: boolean}>}
 */
function readDice(dice) {
  if (!Array.isArray(dice)) return [];
  return dice.map((d) => {
    if (!d || typeof d !== 'object') return { type: 'd?', value: -1, face: '-1', readable: false };
    const type = typeof d.type === 'string' && d.type.trim() ? d.type.trim().toLowerCase() : 'd?';
    const raw = d.face !== undefined && d.face !== null ? d.face : d.value;
    const face = String(raw === undefined || raw === null ? '-1' : raw).trim();
    const value = typeof d.value === 'number' ? d.value : faceNumber(face);
    const readable = (d.readable === undefined || d.readable === true)
      && Number.isInteger(value) && value >= 0;
    return { type, value: readable ? value : -1, face, readable };
  });
}

/**
 * A die as shown to people: the face as printed ("00" stays "00"), a pip
 * die's dot count, "?" for a die the camera couldn't read.
 * @param {{value: number, face: string, readable: boolean}} die
 * @returns {string}
 */
function displayFace(die) {
  if (!die.readable) return '?';
  return /^pip_/.test(die.face) ? String(die.value) : die.face;
}

/**
 * "2d8, 1d20" from a list of dice.
 * @param {Array<{type: string}>} dice
 * @returns {string}
 */
function summarizeDice(dice) {
  const counts = new Map();
  for (const die of dice) counts.set(die.type, (counts.get(die.type) || 0) + 1);
  return [...counts].map(([type, n]) => `${n}${type}`).join(', ');
}

/**
 * Escape text for innerHTML (die types and faces come from the server).
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Convert DiceVision roll format to Talespire dice result format.
 *
 * DiceVision format:
 *   { dice: [{type: "d20", value: 15}, {type: "d6", value: 4}], total: 19 }
 *
 * Talespire format (single dice type):
 *   { name: "Physical Dice", result: { kind: "d20", results: [15] } }
 *
 * Talespire format (multiple dice types):
 *   { name: "Physical Dice", result: { operator: "+", operands: [...] } }
 *
 * @see https://symbiote-docs.talespire.com/api_doc_v0_1.md.html
 * @param {Object} rollData - DiceVision roll data
 * @param {string} rollName - Name for the roll
 * @returns {Object} Talespire dice result group
 */
function convertToTalespireFormat(rollData, rollName = 'Physical Dice') {
  const { dice, total } = rollData;

  if (!dice || dice.length === 0) {
    return null;
  }

  // Group dice by type
  const diceByType = {};
  for (const die of dice) {
    const dieType = die.type.toLowerCase();
    if (!diceByType[dieType]) {
      diceByType[dieType] = [];
    }
    diceByType[dieType].push(die.value);
  }

  // Build rollResult for each dice type
  const rollResults = [];
  for (const [dieType, values] of Object.entries(diceByType)) {
    rollResults.push({
      kind: dieType,    // 'd20', 'd6', etc.
      results: values,  // Plain array of integers [3, 2]
    });
  }

  // Single dice type - return rollResult directly (no operator needed)
  if (rollResults.length === 1) {
    return {
      name: rollName,
      result: rollResults[0],
    };
  }

  // Multiple dice types - combine with operator
  // Operators require exactly 2 operands, so we need to nest for more
  let combined = rollResults[0];
  for (let i = 1; i < rollResults.length; i++) {
    combined = {
      operator: '+',
      operands: [combined, rollResults[i]],
    };
  }

  return {
    name: rollName,
    result: combined,
  };
}

/**
 * Send a roll result to Talespire's dice tray, and announce it in chat.
 * @param {Object} rollData - DiceVision roll data
 * @param {Object} options - { rollName, chatAnnounce, chatTarget }
 * @returns {Promise<{sent: boolean, error?: string, chatError?: string}>}
 *   sent: whether it reached the tray (error says why not); chatError: the
 *   roll reached the tray but the chat announcement failed. Never throws.
 */
async function sendToTalespire(rollData, options = {}) {
  const {
    rollName = 'Physical Dice',
    chatAnnounce = true,
    chatTarget = 'board',
  } = options;

  debugLog('Sending roll to Talespire', { rollData, options });

  // Check if Talespire API is available
  if (typeof TS === 'undefined') {
    debugLog('Talespire API not available');
    return { sent: false, error: 'TaleSpire API not available' };
  }

  // Convert to Talespire format
  const resultGroup = convertToTalespireFormat(rollData, rollName);
  if (!resultGroup) {
    debugLog('Failed to convert roll data');
    return { sent: false, error: 'no dice to send' };
  }
  debugLog('Converted roll format', resultGroup);

  // Send to dice tray (failures reject, e.g. { cause: 'invalidDiceType' })
  try {
    const rollId = await TS.dice.sendDiceResult([resultGroup]);
    debugLog('Roll sent to dice tray', { rollId });
  } catch (err) {
    const error = describeError(err);
    console.error('[DiceVision] Sending the roll to the dice tray failed:', error, err);
    return { sent: false, error };
  }

  // Optionally announce in chat. The roll is already in the tray, so a chat
  // failure doesn't count the roll as failed, but it's reported.
  if (chatAnnounce) {
    const diceStr = formatDiceString(rollData.dice);
    const message = `${rollName}: ${diceStr} = ${rollData.total}`;
    // GM whisper: Talespire's keyword for all GMs is "gms" (the option
    // value stays 'gm' so saved settings keep working)
    const target = chatTarget === 'gm' ? 'gms' : 'board';
    try {
      await TS.chat.send(message, target);
      debugLog('Chat message sent', { message, target });
    } catch (err) {
      const chatError = describeError(err);
      console.error('[DiceVision] Chat announcement failed:', chatError, err);
      return { sent: true, chatError };
    }
  }

  debugLog('Roll sent successfully');
  return { sent: true };
}

/**
 * Tell the player something while the symbiote's panel is hidden: a
 * TaleSpire notification (clicking it opens the panel; needs the manifest's
 * interop id), or if that fails, a chat whisper to the player. Does nothing
 * while the panel is visible. Never throws.
 * @param {string} message
 * @returns {Promise<'visible'|'notification'|'whisper'|'none'>} What was done
 */
async function notifyOutsidePanel(message) {
  if (typeof TS === 'undefined') return 'none';
  try {
    if (await TS.symbiote.getIfThisSymbioteIsVisible()) return 'visible';
  } catch (err) {
    console.warn('[DiceVision] Could not check panel visibility:', err);
  }
  try {
    await TS.symbiote.sendNotification('DiceVision', message);
    return 'notification';
  } catch (err) {
    console.warn('[DiceVision] Notification failed, whispering instead:', err);
  }
  try {
    const me = await TS.players.whoAmI();
    await TS.chat.send(`DiceVision: ${message}`, me.id);
    return 'whisper';
  } catch (err) {
    console.error('[DiceVision] Could not tell the player outside the panel:', err);
    return 'none';
  }
}

/**
 * Format dice array as a readable string (e.g., "1d20(15) + 2d6(4, 3)"),
 * with faces as printed ("1d10(00)")
 * @param {Array} dice - Array of read dice (see readDice)
 * @returns {string}
 */
function formatDiceString(dice) {
  // Group by type
  const groups = {};
  for (const die of dice) {
    const type = die.type.toLowerCase();
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(displayFace(die));
  }

  // Format each group
  const parts = [];
  for (const [type, values] of Object.entries(groups)) {
    const valuesStr = values.join(', ');
    parts.push(`${values.length}${type}(${valuesStr})`);
  }

  return parts.join(' + ');
}

// ============================================================================
// UI Controller
// ============================================================================

class UIController {
  constructor() {
    this.bridge = new DiceVisionBridge();
    this.recentRolls = [];

    // DOM elements
    this.elements = {
      statusIndicator: document.getElementById('status-indicator'),
      statusText: document.getElementById('status-text'),
      sessionCodeInput: document.getElementById('session-code'),
      connectBtn: document.getElementById('connect-btn'),
      disconnectBtn: document.getElementById('disconnect-btn'),
      disconnectContainer: document.getElementById('disconnect-container'),
      optionsPanel: document.getElementById('options-panel'),
      rollsPanel: document.getElementById('rolls-panel'),
      rollsList: document.getElementById('rolls-list'),
      chatAnnounce: document.getElementById('chat-announce'),
      rollTarget: document.getElementById('roll-target'),
      rollName: document.getElementById('roll-name'),
      errorDisplay: document.getElementById('error-display'),
      errorMessage: document.getElementById('error-message'),
      errorDismiss: document.getElementById('error-dismiss'),
      // Roll mode elements
      modePanel: document.getElementById('mode-panel'),
      continuousModeToggle: document.getElementById('continuous-mode'),
      rollOnceBtn: document.getElementById('roll-once-btn'),
      waitingDot: document.getElementById('waiting-dot'),
      waitingText: document.getElementById('waiting-text'),
    };

    // The outside-the-panel notice for an unusable roll was sent, and no roll
    // has gone through since (see handleUnusableRoll)
    this.unusableNotified = false;

    this.init().catch((err) => {
      console.error('[DiceVision] Failed to start:', err);
      this.showError(`DiceVision failed to start (${describeError(err)}). Reopen the symbiote.`);
    });
  }

  /**
   * Initialize the UI controller.
   */
  async init() {
    debugLog('Setting up event listeners');

    // Set up bridge callbacks
    this.bridge.onStatusChange = (status) => this.handleStatusChange(status);
    this.bridge.onRoll = (rollData) => this.handleRoll(rollData);
    this.bridge.onUnusableRoll = (rollData, unreadable) => this.handleUnusableRoll(rollData, unreadable);
    this.bridge.onError = (message) => this.showError(message);
    this.bridge.onModeChange = (continuous, waiting, pendingOnce) =>
      this.handleModeChange(continuous, waiting, pendingOnce);
    campaignStore.onSaveFailed = (reason) =>
      this.showError(`Couldn't save DiceVision settings (${reason}). They may reset next time.`);

    // Set up event listeners
    this.elements.connectBtn.addEventListener('click', () => this.handleConnect());
    this.elements.disconnectBtn.addEventListener('click', () => this.handleDisconnect());
    this.elements.errorDismiss.addEventListener('click', () => this.hideError());

    // Handle Enter key in session code input
    this.elements.sessionCodeInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.handleConnect();
      }
    });

    // Save options on change
    this.elements.chatAnnounce.addEventListener('change', () => this.saveOptions());
    this.elements.rollTarget.addEventListener('change', () => this.saveOptions());
    this.elements.rollName.addEventListener('change', () => this.saveOptions());

    // Roll mode event listeners
    this.elements.continuousModeToggle.addEventListener('change', (e) => {
      this.unusableNotified = false;
      if (e.target.checked) {
        this.bridge.enableContinuousMode();
      } else {
        this.bridge.disableContinuousMode();
      }
      this.saveOptions();
    });

    this.elements.rollOnceBtn.addEventListener('click', () => {
      this.unusableNotified = false;
      this.bridge.rollOnce();
    });

    // Load saved state
    await this.loadSavedState();
  }

  /**
   * Load saved session code and options from Talespire storage.
   */
  async loadSavedState() {
    let state = await campaignStore.load();
    if (state === null) {
      this.showError(`Couldn't read saved DiceVision settings (${campaignStore.lastReadError}).`);
      state = {};
    }

    // Load options first, so an auto-connect starts in the saved mode
    const options = state.options && typeof state.options === 'object' ? state.options : {};
    if (typeof options.chatAnnounce === 'boolean') {
      this.elements.chatAnnounce.checked = options.chatAnnounce;
    }
    if (options.rollTarget) {
      this.elements.rollTarget.value = options.rollTarget;
    }
    if (options.rollName) {
      this.elements.rollName.value = options.rollName;
    }
    if (typeof options.continuousMode === 'boolean') {
      this.elements.continuousModeToggle.checked = options.continuousMode;
      this.bridge.continuousMode = options.continuousMode;
    }

    // Auto-connect if we have a saved code
    if (typeof state.sessionCode === 'string' && state.sessionCode) {
      this.elements.sessionCodeInput.value = state.sessionCode;
      this.handleConnect();
    }
  }

  /**
   * Save the session code to Talespire storage.
   * @param {string} code
   */
  async saveSessionCode(code) {
    await campaignStore.update({ sessionCode: code });
  }

  /**
   * Save options to Talespire storage.
   */
  async saveOptions() {
    await campaignStore.update({
      options: {
        chatAnnounce: this.elements.chatAnnounce.checked,
        rollTarget: this.elements.rollTarget.value,
        rollName: this.elements.rollName.value,
        continuousMode: this.elements.continuousModeToggle.checked,
      },
    });
  }

  /**
   * Handle the connect button click.
   */
  async handleConnect() {
    const code = this.elements.sessionCodeInput.value.trim();
    debugLog('Connect button clicked', { code: code });

    if (!code) {
      this.showError('Please enter a session code');
      return;
    }

    this.elements.connectBtn.disabled = true;
    await this.saveSessionCode(code);
    this.bridge.connect(code);
  }

  /**
   * Handle the disconnect button click.
   */
  handleDisconnect() {
    this.bridge.disconnect();
    this.elements.connectBtn.disabled = false;
  }

  /**
   * Handle connection status changes.
   * @param {'disconnected'|'connecting'|'connected'|'error'} status
   */
  handleStatusChange(status) {
    // Update status indicator
    this.elements.statusIndicator.className = `status ${status}`;

    const statusLabels = {
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      connected: 'Connected',
      error: 'Error',
    };
    this.elements.statusText.textContent = statusLabels[status] || status;

    // Update UI visibility based on connection state
    const isConnected = status === 'connected';
    if (isConnected || status === 'disconnected') {
      this.unusableNotified = false;
    }
    this.elements.modePanel.style.display = isConnected ? 'block' : 'none';
    this.elements.optionsPanel.style.display = isConnected ? 'block' : 'none';
    this.elements.rollsPanel.style.display = isConnected ? 'block' : 'none';
    this.elements.disconnectContainer.style.display = isConnected ? 'block' : 'none';

    // Update button states
    this.elements.connectBtn.disabled = status === 'connecting' || isConnected;
    this.elements.sessionCodeInput.disabled = status === 'connecting' || isConnected;

    // Update mode controls on connect/disconnect
    if (isConnected) {
      this.elements.continuousModeToggle.disabled = false;
      this.updateRollOnceButton();
    } else {
      this.elements.continuousModeToggle.disabled = true;
      this.elements.rollOnceBtn.disabled = true;
    }
  }

  /**
   * Handle a dice roll from DiceVision.
   * @param {Object} rollData
   */
  async handleRoll(rollData) {
    this.unusableNotified = false;

    // Get current options
    const options = {
      rollName: this.elements.rollName.value || 'Physical Dice',
      chatAnnounce: this.elements.chatAnnounce.checked,
      chatTarget: this.elements.rollTarget.value,
    };

    // Send to Talespire
    const result = await sendToTalespire(rollData, options);
    if (!result.sent) {
      this.showError(`Couldn't send the roll to the dice tray (${result.error}).`);
    } else if (result.chatError) {
      this.showError(`Roll sent to the dice tray, but the chat announcement failed (${result.chatError}).`);
    }

    // Add to recent rolls list
    this.addRecentRoll(rollData, result.sent);
  }

  /**
   * A roll with a die the camera couldn't read (or no dice): it wasn't sent to
   * the dice tray, and the bridge keeps waiting for the reroll.
   * @param {Object} rollData
   * @param {Array} unreadable - The dice that couldn't be read
   * @returns {Promise<string>} What notifyOutsidePanel did, or 'already-notified'
   */
  handleUnusableRoll(rollData, unreadable) {
    const message = unreadable.length
      ? `Couldn't read ${summarizeDice(unreadable)}. Roll again; still waiting.`
      : 'That roll had no dice. Roll again; still waiting.';
    this.showError(message);
    this.addRecentRoll(rollData, false, true);
    // The panel's message is invisible while the panel is closed. Tell the
    // player outside it, once until a roll goes through (or Roll Once, a mode
    // change, or a reconnect): in continuous mode a die left on the table
    // would otherwise notify on every capture. Only a notice that went out
    // counts; with the panel open nothing is sent, so the next one still can.
    if (this.unusableNotified) return Promise.resolve('already-notified');
    this.unusableNotified = true; // held while sending, so two captures don't both notify
    return notifyOutsidePanel(message).then((result) => {
      if (result !== 'notification' && result !== 'whisper') this.unusableNotified = false;
      return result;
    });
  }

  /**
   * Add a roll to the recent rolls list.
   * @param {Object} rollData
   * @param {boolean} success
   * @param {boolean} [notSent] - Not sent to the tray (a die couldn't be read)
   */
  addRecentRoll(rollData, success, notSent = false) {
    // Add to beginning of array
    this.recentRolls.unshift({
      ...rollData,
      success,
      notSent,
      displayTime: new Date().toLocaleTimeString(),
    });

    // Limit to max recent rolls
    if (this.recentRolls.length > CONFIG.MAX_RECENT_ROLLS) {
      this.recentRolls.pop();
    }

    // Update UI
    this.renderRecentRolls();
  }

  /**
   * Render the recent rolls list.
   */
  renderRecentRolls() {
    if (this.recentRolls.length === 0) {
      this.elements.rollsList.innerHTML = '<p class="empty-state">No rolls yet</p>';
      return;
    }

    const html = this.recentRolls.map(roll => {
      const diceHtml = roll.dice.map(d =>
        `<span class="die-result${d.readable ? '' : ' unreadable'}">${escapeHtml(d.type)}: ${escapeHtml(displayFace(d))}</span>`
      ).join('');

      return `
        <div class="roll-item${roll.notSent ? ' not-sent' : ''}">
          <div>
            <div class="roll-dice">${diceHtml}</div>
            <div class="roll-time">${roll.displayTime}${roll.notSent ? ' &middot; not sent, roll again' : ''}</div>
          </div>
          <div class="roll-total">${roll.notSent ? '&ndash;' : escapeHtml(String(roll.total))}</div>
        </div>
      `;
    }).join('');

    this.elements.rollsList.innerHTML = html;
  }

  /**
   * Show an error message.
   * @param {string} message
   */
  showError(message) {
    this.elements.errorMessage.textContent = message;
    this.elements.errorDisplay.style.display = 'flex';

    // Auto-hide after 5 seconds
    setTimeout(() => this.hideError(), 5000);
  }

  /**
   * Hide the error message.
   */
  hideError() {
    this.elements.errorDisplay.style.display = 'none';
  }

  /**
   * Handle mode state changes from the bridge.
   * @param {boolean} continuous - Whether continuous mode is enabled
   * @param {boolean} waiting - Whether currently registered as waiting
   * @param {boolean} pendingOnce - Whether waiting for a single roll
   */
  handleModeChange(continuous, waiting, pendingOnce) {
    // Update toggle state (in case changed externally)
    this.elements.continuousModeToggle.checked = continuous;

    // Update Roll Once button state
    this.updateRollOnceButton();

    // Update waiting status indicator
    if (waiting) {
      if (pendingOnce) {
        // Waiting for single roll
        this.elements.waitingDot.className = 'waiting-dot single';
        this.elements.waitingText.textContent = 'Waiting for single roll...';
      } else if (continuous) {
        // Continuous mode active
        this.elements.waitingDot.className = 'waiting-dot continuous';
        this.elements.waitingText.textContent = 'Continuous mode active';
      } else {
        // Shouldn't happen, but handle gracefully
        this.elements.waitingDot.className = 'waiting-dot';
        this.elements.waitingText.textContent = 'Waiting for rolls';
      }
    } else {
      // Not waiting
      this.elements.waitingDot.className = 'waiting-dot';
      this.elements.waitingText.textContent = 'Not waiting for rolls';
    }
  }

  /**
   * Update the Roll Once button state based on current mode.
   */
  updateRollOnceButton() {
    const bridge = this.bridge;
    // Disable when:
    // - Continuous mode is ON (use toggle instead)
    // - Already waiting (either continuous or single roll pending)
    // - Not connected
    const shouldDisable =
      bridge.continuousMode ||
      bridge.isWaiting ||
      !bridge.isConnected();

    this.elements.rollOnceBtn.disabled = shouldDisable;
  }
}

// ============================================================================
// Talespire Event Handler (called by manifest subscription)
// ============================================================================

// IMPORTANT: Must be a global function, not a scoped variable
function handleSymbioteStateChange(event) {
  debugLog('Symbiote state change', event);

  if (event.kind === 'hasInitialized') {
    debugLog('Talespire API initialized');
    initApp();
  } else if (event.kind === 'willShutdown') {
    debugLog('Symbiote shutting down');
    // Clean up if needed
    if (window.dicevisionUI && window.dicevisionUI.bridge) {
      window.dicevisionUI.bridge.disconnect();
    }
  }
}

// ============================================================================
// Initialize
// ============================================================================

// Initialize the UI (called after hasInitialized event)
function initApp() {
  debugLog('Initializing UI controller');
  window.dicevisionUI = new UIController();
  debugLog('UI controller ready');
}
