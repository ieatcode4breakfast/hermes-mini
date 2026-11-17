// Password, secret and vault prompt cards. Hermes asks for a value with one of these server->client requests and
// waits on the JSON-RPC answer; app.js draws the card, collects the fields and sends what this module returns.
// Pure: which methods are prompts, the text and fields each one shows, and the answer frame's result.
// A password is never trimmed, and nothing here copies a value anywhere but into the answer.

const PROMPT_METHODS = [
  "sudo",
  "display.install.sudo",
  "secret",
  "vault.unlock_prompt",
  "vault.save_login",
  "vault.code",
];

const MASKED_SUDO_FIELD = [
  { name: "value", label: "Sudo password", placeholder: "sudo password", masked: true, required: true, autocomplete: "off" },
];

const CANCELLED_OUTCOME = "Closed without an answer";

export function isPromptMethod(method) {
  return PROMPT_METHODS.includes(method);
}

// Only an https link is ever put into an anchor.
export function safeHttpsUrl(url) {
  const text = String(url || "").trim();
  return /^https:\/\/[^\s]+$/i.test(text) ? text : "";
}

// The card's text and fields for one request. Null for a method that is not a prompt.
export function describePrompt(method, params = {}) {
  const spec = {
    method,
    title: "",
    subtitle: "",
    badge: "",
    description: "",
    command: "",
    helpUrl: "",
    helpText: "",
    fields: [],
    submitLabel: "Submit",
    skipLabel: "Skip",
    sentOutcome: "Sent",
    skippedOutcome: "Skipped",
    cancelledOutcome: CANCELLED_OUTCOME,
    sentInsteadOutcome: "Prompt skipped — you sent a message instead",
  };

  if (method === "sudo") {
    spec.command = String(params.command || "").trim();
    spec.title = "Administrator password";
    spec.description = spec.command
      ? "Enter your sudo password to run this command for this session."
      : "This agent did not provide the command. Skip if you cannot verify it in the conversation.";
    spec.fields = MASKED_SUDO_FIELD;
    spec.sentOutcome = "Password sent";
    spec.sentInsteadOutcome = "Prompt skipped — you sent a message instead";
    return spec;
  }

  if (method === "display.install.sudo") {
    spec.title = "Administrator password";
    spec.description = "Hermes needs your sudo password to install the Bot Screen packages on the gateway host.";
    spec.fields = MASKED_SUDO_FIELD;
    spec.sentOutcome = "Password sent";
    spec.sentInsteadOutcome = "Prompt skipped — you sent a message instead";
    return spec;
  }

  if (method === "secret") {
    const envVar = String(params.env_var || "").trim();
    const meta = params.metadata && typeof params.metadata === "object" ? params.metadata : {};
    const skill = String(meta.skill_name || "").trim();
    const reqFor = String(meta.required_for || "").trim();
    spec.subtitle = skill ? (reqFor ? "Skill: " + skill + " (" + reqFor + ")" : "Skill: " + skill) : reqFor;
    spec.badge = envVar;
    spec.title = "Secret required";
    spec.description = String(params.prompt || "").trim() || (envVar ? "Enter value for " + envVar : "Hermes needs a credential to continue.");
    const helpRaw = String(meta.help || "").trim();
    spec.helpUrl = safeHttpsUrl(helpRaw);
    spec.helpText = spec.helpUrl ? "" : helpRaw;
    spec.fields = [
      { name: "value", label: envVar || "Secret", placeholder: "secret value", masked: true, required: true, autocomplete: "off" },
    ];
    spec.sentOutcome = envVar ? "Saved " + envVar : "Secret saved";
    spec.sentInsteadOutcome = "Secret skipped — you sent a message instead";
    return spec;
  }

  if (method === "vault.unlock_prompt") {
    const name = String(params.display_name || params.backend || "password vault").trim();
    spec.title = "Unlock " + name;
    spec.description = "Enter your master password to unlock " + name + " for this session. It goes straight to the vault and is never saved in chat.";
    spec.fields = [
      { name: "value", label: "Master password", placeholder: "Master password", masked: true, required: true, autocomplete: "off" },
    ];
    spec.submitLabel = "Unlock";
    spec.skipLabel = "Keep locked";
    spec.sentOutcome = "Unlocked";
    spec.skippedOutcome = "Kept locked";
    spec.sentInsteadOutcome = "Unlock skipped — you sent a message instead";
    return spec;
  }

  if (method === "vault.save_login") {
    const origin = String(params.origin || "").trim();
    const site = String(params.site || origin || "this site").trim();
    spec.title = "Save " + site + " login?";
    spec.description =
      (origin
        ? "Hermes reached a sign-in page at " + origin + " and has no saved login for it."
        : "Enter your login for " + site + ".") +
      " It is encrypted on the machine without the model seeing your password.";
    spec.fields = [
      { name: "identifier", label: "Email or username", placeholder: "you@example.com", masked: false, required: false, autocomplete: "off" },
      { name: "password", label: "Password", placeholder: "Password", masked: true, required: true, autocomplete: "off" },
    ];
    spec.submitLabel = "Save & sign in";
    spec.skipLabel = "Don't save";
    spec.sentOutcome = "Login saved for " + site;
    spec.skippedOutcome = "Not saved";
    spec.sentInsteadOutcome = "Login prompt skipped — you sent a message instead";
    return spec;
  }

  if (method === "vault.code") {
    const site = String(params.site || "").trim();
    const hint = String(params.hint || "").trim();
    spec.title = site ? "Verification code for " + site : "Verification code";
    spec.description = (site || "This site") + " is asking for a one-time code." + (hint ? " " + hint : "");
    spec.fields = [
      { name: "value", label: "Code", placeholder: "One-time code", masked: false, required: true, autocomplete: "one-time-code" },
    ];
    spec.submitLabel = "Enter code";
    spec.sentOutcome = "Code sent";
    spec.sentInsteadOutcome = "Code skipped — you sent a message instead";
    return spec;
  }

  return null;
}

// The JSON-RPC result for an answer: *values* from the fields, or null for Skip (an empty value).
// A missing required value is null, so a card cannot send an empty password.
export function buildPromptResult(method, values) {
  if (values == null) return { value: "" };

  if (method === "vault.save_login") {
    const password = String(values.password ?? "");
    if (!password) return null;
    const identifier = String(values.identifier ?? "").trim();
    return { value: JSON.stringify({ identifier, password }) };
  }

  if (method === "secret" || method === "vault.code") {
    const val = String(values.value ?? "").trim();
    if (!val) return null;
    return { value: val };
  }

  const val = String(values.value ?? "");
  if (!val) return null;
  return { value: val };
}
