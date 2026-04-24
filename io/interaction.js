"use strict";

/**
 * Interaction interface factory.
 *
 * Wraps an adapter (CLI, WebSocket, etc.) in a consistent API used by all
 * division runners. Callers never import readline or any transport directly.
 *
 * Adapter contract:
 *   adapter.turn(prompt: string) → Promise<string>
 */
function createInteraction(adapter) {
  return {
    /**
     * Ask a single question and return the user's answer.
     * @param {string} prompt  Text shown to the user.
     * @returns {Promise<string>}
     */
    turn(prompt, opts) {
      return adapter.turn(prompt, opts);
    },

    /**
     * Release any resources held by the adapter (e.g. close the readline
     * interface so the process can exit cleanly).
     */
    close() {
      if (adapter.close) adapter.close();
    },
  };
}

module.exports = { createInteraction };
