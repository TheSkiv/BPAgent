/**
 * Interactive plate lookup — designed for port operators.
 *
 * Usage:  node src/lookupInteractive.js
 *
 * - Prompts for a plate, shows result, loops until the operator exits.
 * - No terminal knowledge required. Works by double-clicking a shortcut
 *   that runs:  node "C:\PortSystem\src\lookupInteractive.js"
 * - Type EXIT (or press Ctrl+C) to quit.
 */

require('dotenv').config();

const readline = require('readline');
const { searchPlate }  = require('./lookup');
const { todayString }  = require('./core/dateManager');

// ── output helpers ────────────────────────────────────────────────────────────

const LINE  = '─'.repeat(44);
const BLANK = '';

function header() {
  console.log(BLANK);
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       PORT SYSTEM — PLATE LOOKUP         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Today: ${todayString()}`);
  console.log(`  Type EXIT to quit.`);
  console.log(BLANK);
}

function printFound(result) {
  console.log(BLANK);
  console.log(`  ✔  FOUND — ${result.matches.length} record(s) for ${result.query}`);
  for (const row of result.matches) {
    console.log(`  ${LINE}`);
    console.log(`  Plate:      ${row['Plate']}`);
    if (row['Driver'])     console.log(`  Driver:     ${row['Driver']}`);
    if (row['Reference'])  console.log(`  Reference:  ${row['Reference']}`);
    if (row['From Email']) console.log(`  From:       ${row['From Email']}`);
  }
  console.log(`  ${LINE}`);
  console.log(BLANK);
}

function printNotFound(result) {
  console.log(BLANK);
  console.log(`  ✘  NOT FOUND — ${result.query}`);
  if (result.reason === 'no-file') {
    console.log(`     No orders file for today (${todayString()}).`);
    console.log(`     Run the ingestion first.`);
  } else {
    console.log(`     No record matching this plate today.`);
  }
  console.log(BLANK);
}

// ── main loop ─────────────────────────────────────────────────────────────────

function start() {
  header();

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  // Graceful Ctrl+C
  rl.on('close', () => {
    console.log('\n  Goodbye.\n');
    process.exit(0);
  });

  function prompt() {
    rl.question('  Enter plate: ', (raw) => {
      const input = raw.trim();

      if (!input) {
        // Empty input — just re-prompt
        return prompt();
      }

      if (input.toUpperCase() === 'EXIT') {
        rl.close();
        return;
      }

      const result = searchPlate(input);
      result.found ? printFound(result) : printNotFound(result);

      prompt();
    });
  }

  prompt();
}

start();
