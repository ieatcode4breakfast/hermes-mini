// Computer markup, shared by both pages that host the viewer (the chat app and the standalone page). screen.js
// inserts it into <body> when the page does not already have #botScreen.
// The agent's name fills NAME; screen.js escapes it.
export const botScreenHtml = (NAME) => `
<section id="botScreen" class="bot-screen" role="dialog" aria-modal="true" aria-labelledby="bsTitle" hidden>
  <header class="bs-bar">
    <button id="bsBack" class="bs-back" type="button" aria-label="Back to chat" title="Back to chat">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
    </button>
    <h2 id="bsTitle" class="bs-title"><span class="bs-title-text">${NAME}'s Computer</span><svg class="bs-title-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></h2>
  </header>

  <p id="bsBanner" class="bs-banner" role="status" hidden></p>

  <div id="bsStage" class="bs-stage">
    <div id="bsHost" class="bs-host" data-terminal data-remote-screen></div>
    <div id="bsOverlay" class="bs-overlay">
      <div class="bs-card">
        <h3 id="bsOverlayTitle">Checking the screen…</h3>
        <p id="bsOverlayBody">This only reads the bot's desktop status.</p>
      </div>
    </div>
    <!-- Phones: a visible trackpad surface under the picture. trackpad.js listens on it too, so
         it drives the pointer like a laptop pad. screen.js sizes it and shows it only on touch, portrait, with room. -->
    <div id="bsPad" class="bs-pad" hidden aria-label="Trackpad">
      <span class="bs-pad-label">Trackpad</span>
    </div>
    <button id="bsHelp" class="bs-help-btn" type="button" aria-label="How to use the trackpad" title="How to use the trackpad" hidden>?</button>
    <!-- Floating over the desktop itself, never in the flow: ownership on the left, actions on the right.
         The wrapper and the label are click-through so the remote desktop keeps the pixels around them;
         only the action buttons take taps. z-index above .bs-overlay so refresh/start stay usable. -->
    <div id="bsFloat" class="bs-float">
      <!-- Hand Back sits right next to "You're in control". No Take Over button: any input while
           watching takes control, so Hand Back is the only lease action left, and its ring counts down the last 5 s
           before the automatic hand-back. -->
      <div class="bs-lease-group">
        <span id="bsLease" class="bs-badge" data-owner="agent" aria-live="polite">${NAME}'s in control</span>
        <button id="bsHandback" class="bs-btn" type="button" hidden>Hand Back</button>
      </div>
      <div class="bs-controls" role="toolbar" aria-label="${NAME}'s Computer controls">
        <button id="bsStart" class="bs-btn" type="button" hidden>Start Screen</button>
        <button id="bsReconnect" class="bs-btn bs-icon-btn" type="button" aria-label="Reconnect" title="Reconnect">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
        <!-- Clipboard while you hold control: paste yours in, copy the desktop's out. -->
        <button id="bsCopy" class="bs-btn bs-icon-btn" type="button" aria-label="Copy from ${NAME}'s computer" title="Copy from ${NAME}'s computer" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button id="bsPaste" class="bs-btn bs-icon-btn" type="button" aria-label="Paste into ${NAME}'s computer" title="Paste into ${NAME}'s computer" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11v6M9 14l3 3 3-3"/></svg>
        </button>
        <button id="bsKeyboard" class="bs-btn bs-icon-btn" type="button" aria-label="Open remote keyboard" title="Keyboard">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>
        </button>
      </div>
    </div>
  </div>

  <!-- Trackpad help sheet (the ? on the pad). Tap anywhere to close. -->
  <div id="bsHelpSheet" class="bs-help-scrim" hidden>
    <div class="bs-help-card" role="dialog" aria-modal="true" aria-labelledby="bsHelpTitle">
      <h3 id="bsHelpTitle">How to use the trackpad</h3>
      <p class="bs-help-note">Tap the screen or type to take over. Zoom and pan work while watching; 20 s without input hands back.</p>
      <dl class="bs-help-list">
        <dt>Move pointer</dt><dd>Slide one finger</dd>
        <dt>Click</dt><dd>Tap</dd>
        <dt>Double-click</dt><dd>Tap twice</dd>
        <dt>Right click</dt><dd>Two-finger tap, or press and hold</dd>
        <dt>Drag / select</dt><dd>Tap, then touch again and slide</dd>
        <dt>Scroll</dt><dd>Slide two fingers</dd>
        <dt>Zoom</dt><dd>Pinch out or in</dd>
        <dt>Pan while zoomed</dt><dd>Slide two fingers</dd>
        <dt>Middle click</dt><dd>Three-finger tap</dd>
        <dt>Type</dt><dd>Tap the keyboard button (last icon)</dd>
      </dl>
      <button id="bsHelpClose" class="bs-btn" type="button">Got it</button>
    </div>
  </div>

  <!-- Off-screen but focusable: focusing it summons the mobile keyboard; its input/composition events become remote
       keysyms (screen.js). It never overlaps the remote canvas, so it cannot double-deliver physical keystrokes. -->
  <textarea id="bsKbd" class="bs-kbd" rows="1" aria-label="Remote keyboard input" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>

  <!-- Phones cannot read a screenshot off the clipboard: Paste opens this picker instead, and
       screen.js uploads the chosen image to the remote's clipboard. Visually hidden, never in the focus order. -->
  <input id="bsImagePick" class="bs-image-pick" type="file" accept="image/*" tabindex="-1" aria-hidden="true" />
</section>
`;
