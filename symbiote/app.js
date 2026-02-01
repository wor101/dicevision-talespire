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

  // Storage keys
  STORAGE_KEY_SESSION: 'dicevision_session_code',
  STORAGE_KEY_OPTIONS: 'dicevision_options',
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

    // Callbacks
    this.onStatusChange = null;
    this.onRoll = null;
    this.onError = null;
  }

  /**
   * Connect to the DiceVision bridge with the given session code.
   * @param {string} sessionCode - 6-character session code
   */
  connect(sessionCode) {
    debugLog('Connecting to bridge', { sessionCode: sessionCode });

    if (!sessionCode || sessionCode.length < 4) {
      this.handleError('Invalid session code');
      return;
    }

    // Normalize session code (uppercase, no dashes)
    this.sessionCode = sessionCode.toUpperCase().replace(/-/g, '');
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

    // Register as waiting for rolls (required to receive roll data)
    this.send({ type: 'waiting', app_id: 'talespire' });
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
   * @param {Object} rollData - { dice: [{type, value}], total, roll_id, timestamp }
   */
  handleRoll(rollData) {
    console.log('[DiceVision] Roll received:', rollData);

    if (this.onRoll) {
      this.onRoll(rollData);
    }

    // Re-register as waiting for the next roll
    // (waiting state is cleared after each roll delivery)
    this.send({ type: 'waiting', app_id: 'talespire' });
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
    try {
      if (typeof TS !== 'undefined' && TS.localStorage && TS.localStorage.campaign) {
        await TS.localStorage.campaign.removeBlob(CONFIG.STORAGE_KEY_SESSION);
      }
    } catch (err) {
      console.error('[DiceVision] Failed to clear saved session:', err);
    }
  }

  /**
   * Check if currently connected.
   * @returns {boolean}
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

// ============================================================================
// Talespire Integration
// ============================================================================

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
 * Send a roll result to Talespire's dice tray.
 * @param {Object} rollData - DiceVision roll data
 * @param {Object} options - { rollName, chatAnnounce, chatTarget }
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
    return false;
  }

  try {
    // Convert to Talespire format
    const resultGroup = convertToTalespireFormat(rollData, rollName);
    if (!resultGroup) {
      debugLog('Failed to convert roll data');
      return false;
    }

    debugLog('Converted roll format', resultGroup);

    // Send to dice tray
    const diceResult = await TS.dice.sendDiceResult([resultGroup]);
    if (diceResult && diceResult.error) {
      debugLog('Dice result error', diceResult);
    }
    debugLog('Roll sent to dice tray', { result: diceResult });

    // Optionally announce in chat
    if (chatAnnounce) {
      const diceStr = formatDiceString(rollData.dice);
      const message = `${rollName}: ${diceStr} = ${rollData.total}`;

      if (chatTarget === 'gm') {
        // GM whisper
        await TS.chat.send(message, 'gm');
      } else {
        // Board message (visible to all)
        await TS.chat.send(message, 'board');
      }
      debugLog('Chat message sent', { message, target: chatTarget });
    }

    debugLog('Roll sent successfully');
    return true;
  } catch (err) {
    debugLog('Failed to send to Talespire', { error: err.message });
    return false;
  }
}

/**
 * Format dice array as a readable string (e.g., "1d20(15) + 2d6(4, 3)")
 * @param {Array} dice - Array of {type, value}
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
    groups[type].push(die.value);
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
    };

    this.init();
  }

  /**
   * Initialize the UI controller.
   */
  async init() {
    debugLog('Setting up event listeners');

    // Set up bridge callbacks
    this.bridge.onStatusChange = (status) => this.handleStatusChange(status);
    this.bridge.onRoll = (rollData) => this.handleRoll(rollData);
    this.bridge.onError = (message) => this.showError(message);

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

    // Load saved state
    await this.loadSavedState();
  }

  /**
   * Load saved session code and options from Talespire storage.
   */
  async loadSavedState() {
    try {
      if (typeof TS !== 'undefined' && TS.localStorage && TS.localStorage.campaign) {
        // Load session code
        const savedCode = await TS.localStorage.campaign.getBlob(CONFIG.STORAGE_KEY_SESSION);
        if (savedCode) {
          this.elements.sessionCodeInput.value = savedCode;
          // Auto-connect if we have a saved code
          this.handleConnect();
        }

        // Load options
        const savedOptions = await TS.localStorage.campaign.getBlob(CONFIG.STORAGE_KEY_OPTIONS);
        if (savedOptions) {
          try {
            const options = JSON.parse(savedOptions);
            if (options.chatAnnounce !== undefined) {
              this.elements.chatAnnounce.checked = options.chatAnnounce;
            }
            if (options.rollTarget) {
              this.elements.rollTarget.value = options.rollTarget;
            }
            if (options.rollName) {
              this.elements.rollName.value = options.rollName;
            }
          } catch (err) {
            console.error('[DiceVision] Failed to parse saved options:', err);
          }
        }
      }
    } catch (err) {
      console.error('[DiceVision] Failed to load saved state:', err);
    }
  }

  /**
   * Save the session code to Talespire storage.
   * @param {string} code
   */
  async saveSessionCode(code) {
    try {
      if (typeof TS !== 'undefined' && TS.localStorage && TS.localStorage.campaign) {
        await TS.localStorage.campaign.setBlob(CONFIG.STORAGE_KEY_SESSION, code);
      }
    } catch (err) {
      console.error('[DiceVision] Failed to save session code:', err);
    }
  }

  /**
   * Save options to Talespire storage.
   */
  async saveOptions() {
    try {
      if (typeof TS !== 'undefined' && TS.localStorage && TS.localStorage.campaign) {
        const options = {
          chatAnnounce: this.elements.chatAnnounce.checked,
          rollTarget: this.elements.rollTarget.value,
          rollName: this.elements.rollName.value,
        };
        await TS.localStorage.campaign.setBlob(
          CONFIG.STORAGE_KEY_OPTIONS,
          JSON.stringify(options)
        );
      }
    } catch (err) {
      console.error('[DiceVision] Failed to save options:', err);
    }
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
    this.elements.optionsPanel.style.display = isConnected ? 'block' : 'none';
    this.elements.rollsPanel.style.display = isConnected ? 'block' : 'none';
    this.elements.disconnectContainer.style.display = isConnected ? 'block' : 'none';

    // Update button states
    this.elements.connectBtn.disabled = status === 'connecting' || isConnected;
    this.elements.sessionCodeInput.disabled = status === 'connecting' || isConnected;
  }

  /**
   * Handle a dice roll from DiceVision.
   * @param {Object} rollData
   */
  async handleRoll(rollData) {
    // Get current options
    const options = {
      rollName: this.elements.rollName.value || 'Physical Dice',
      chatAnnounce: this.elements.chatAnnounce.checked,
      chatTarget: this.elements.rollTarget.value,
    };

    // Send to Talespire
    const success = await sendToTalespire(rollData, options);

    // Add to recent rolls list
    this.addRecentRoll(rollData, success);
  }

  /**
   * Add a roll to the recent rolls list.
   * @param {Object} rollData
   * @param {boolean} success
   */
  addRecentRoll(rollData, success) {
    // Add to beginning of array
    this.recentRolls.unshift({
      ...rollData,
      success,
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
        `<span class="die-result">${d.type}: ${d.value}</span>`
      ).join('');

      return `
        <div class="roll-item">
          <div>
            <div class="roll-dice">${diceHtml}</div>
            <div class="roll-time">${roll.displayTime}</div>
          </div>
          <div class="roll-total">${roll.total}</div>
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
