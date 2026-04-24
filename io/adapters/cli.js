"use strict";

const readline = require("readline");

/**
 * CLI adapter for the interaction interface.
 *
 * One readline interface is created per adapter instance and shared across all
 * turns. This matches the original pattern where a single rl was kept open for
 * the lifetime of an interview, preventing create/close cycles from causing
 * data loss or terminal state issues between turns.
 */
function cliAdapter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    turn(prompt) {
      return new Promise((resolve) => {
        rl.question(prompt, resolve);
      });
    },
    close() {
      rl.close();
    },
  };
}

module.exports = { cliAdapter };
