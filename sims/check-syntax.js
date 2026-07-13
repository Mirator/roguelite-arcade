'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const gamesDir = path.join(rootDir, 'games');
const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function relative(filePath) {
  return path.relative(rootDir, filePath).replaceAll(path.sep, '/');
}

function fail(label, error) {
  console.error(`Syntax check failed: ${label}`);
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}

function compile(source, filename, label) {
  try {
    new vm.Script(source, { filename });
    console.log(`Syntax OK: ${label}`);
  } catch (error) {
    fail(label, error);
  }
}

let gameFiles;
try {
  gameFiles = fs.readdirSync(gamesDir)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => path.join(gamesDir, name));
} catch (error) {
  fail(relative(gamesDir), error);
  process.exit();
}

if (gameFiles.length === 0) {
  fail(relative(gamesDir), new Error('No game HTML files found'));
  process.exit();
}

let inlineScriptCount = 0;
for (const gameFile of gameFiles) {
  const html = fs.readFileSync(gameFile, 'utf8');
  let match;
  let fileScriptCount = 0;

  scriptPattern.lastIndex = 0;
  while ((match = scriptPattern.exec(html)) !== null) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes) || /\btype\s*=\s*["']module["']/i.test(attributes)) {
      continue;
    }

    fileScriptCount += 1;
    inlineScriptCount += 1;
    const label = `${relative(gameFile)} (inline script ${fileScriptCount})`;
    compile(match[2], `${gameFile}:inline-script-${fileScriptCount}`, label);
  }
}

if (inlineScriptCount === 0) {
  fail(relative(gamesDir), new Error('No inline classic scripts found'));
}

const simFiles = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => path.join(__dirname, name));

for (const simFile of simFiles) {
  compile(fs.readFileSync(simFile, 'utf8'), simFile, relative(simFile));
}
