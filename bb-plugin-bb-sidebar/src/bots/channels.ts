/**
 * Realtime channels for the Bots section. The state underneath lives in the
 * inbox-sidebar plugin's database (reached by cross-plugin RPC), so its own
 * channels cannot reach this plugin's clients. These are this plugin's
 * equivalents, published after a proxied write lands.
 */
export const BOTS_SUBTITLES_CHANNEL = "bots-assistant-subtitles";

export const BOTS_ASSISTANT_ORDER_CHANNEL = "bots-assistant-order";
