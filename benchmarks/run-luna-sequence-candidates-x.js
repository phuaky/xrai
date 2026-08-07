#!/usr/bin/env node

// Resumable external Luna runner for second-pass same-claim candidates. Each
// output is written to a temporary file, validated against the exact candidate
// batch and judge configuration, then atomically promoted with a sidecar.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const audit = require('./full-corpus-audit-x.js');
const candidateAudit = require('./sequence-candidate-audit-x.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_AUDIT_DIR = path.join(ROOT, 'data', 'luna-audit-x');

function parseArgs(argv) {
  const options = {
    auditDir: DEFAULT_AUDIT_DIR,
    model: 'gpt-5.6-luna',
    reasoning: 'high',
    parallel: 6,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--audit-dir=')) options.auditDir = path.resolve(arg.slice(12));
    else if (arg.startsWith('--model=')) options.model = arg.slice(8);
    else if (arg.startsWith('--reasoning=')) options.reasoning = arg.slice(12);
    else if (arg.startsWith('--parallel=')) options.parallel = Number(arg.slice(11));
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.model) throw new Error('--model must be non-empty');
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.reasoning)) {
    throw new Error('--reasoning must be minimal, low, medium, high, or xhigh');
  }
  if (!Number.isInteger(options.parallel) || options.parallel < 1 || options.parallel > 16) {
    throw new Error('--parallel must be an integer from 1 to 16');
  }
  return options;
}

function expectedRun(options) {
  return {
    schemaVersion: 1,
    kind: 'rai-x-sequence-candidate-luna-run',
    model: options.model,
    reasoning: options.reasoning,
  };
}

function ensureRun(candidateDir, options) {
  const file = path.join(candidateDir, 'run.json');
  const expected = expectedRun(options);
  if (fs.existsSync(file)) {
    const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (audit.stableJson(actual) !== audit.stableJson(expected)) {
      throw new Error(`${file}: judge configuration differs; use a fresh candidate directory`);
    }
  } else {
    fs.writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
  }
  return expected;
}

function validatedBatch(prepared, batch, run) {
  const outputPath = path.join(prepared.candidateDir, batch.outputFile);
  const validationPath = path.join(prepared.candidateDir, batch.validationFile);
  if (!fs.existsSync(outputPath) || !fs.existsSync(validationPath)) return false;
  try {
    const validated = candidateAudit.validateCandidateOutputFile(
      outputPath,
      batch,
      prepared.batchCandidates.get(batch.file),
      run,
    );
    const sidecar = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
    return audit.stableJson(sidecar) === audit.stableJson(validated.record);
  } catch (_) {
    return false;
  }
}

function pendingBatches(prepared, run) {
  return prepared.manifest.batches.filter((batch) => !validatedBatch(prepared, batch, run));
}

function runBatch(prepared, batch, run) {
  return new Promise((resolve, reject) => {
    const promptPath = path.join(prepared.candidateDir, batch.promptFile);
    const outputPath = path.join(prepared.candidateDir, batch.outputFile);
    const validationPath = path.join(prepared.candidateDir, batch.validationFile);
    const temporaryPath = `${outputPath}.tmp-${process.pid}`;
    const logDir = path.join(prepared.candidateDir, 'logs');
    const stem = path.basename(batch.outputFile, '.jsonl');
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.createWriteStream(path.join(logDir, `${stem}.log`));
    const child = spawn('codex', [
      'exec',
      '-m', run.model,
      '-c', `model_reasoning_effort="${run.reasoning}"`,
      '-s', 'read-only',
      '-C', prepared.candidateDir,
      '-o', temporaryPath,
      '-',
    ], {
      cwd: prepared.candidateDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    fs.createReadStream(promptPath).pipe(child.stdin);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', (error) => {
      log.end();
      reject(error);
    });
    child.on('close', (code) => {
      log.end();
      if (code !== 0) {
        reject(new Error(`${stem}: codex exited ${code}`));
        return;
      }
      try {
        const validated = candidateAudit.validateCandidateOutputFile(
          temporaryPath,
          batch,
          prepared.batchCandidates.get(batch.file),
          run,
        );
        fs.renameSync(temporaryPath, outputPath);
        fs.writeFileSync(validationPath, JSON.stringify(validated.record, null, 2) + '\n');
        resolve(batch);
      } catch (error) {
        reject(new Error(`${stem}: ${error.message || error}`));
      }
    });
  });
}

async function runPool(items, concurrency, task) {
  let next = 0;
  const failures = [];
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      try {
        await task(item);
        console.log(`PASS ${path.basename(item.file, '.jsonl')}`);
      } catch (error) {
        failures.push(String((error && error.message) || error));
        console.error(`FAIL ${path.basename(item.file, '.jsonl')}: ${error.message || error}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return failures;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const prepared = candidateAudit.loadPrepared(options.auditDir);
  const run = ensureRun(prepared.candidateDir, options);
  const pending = pendingBatches(prepared, run);
  console.log(JSON.stringify({
    model: run.model,
    reasoning: run.reasoning,
    validated: prepared.manifest.batches.length - pending.length,
    pending: pending.length,
    firstPending: pending.length ? pending[0].file : null,
    dryRun: options.dryRun,
  }, null, 2));
  if (options.dryRun || !pending.length) return;

  const failures = await runPool(pending, options.parallel, (batch) => runBatch(prepared, batch, run));
  if (failures.length) throw new Error(`${failures.length} batch call(s) failed`);
  const result = candidateAudit.validateOutputs(options.auditDir, false);
  console.log(JSON.stringify({
    candidateCount: result.candidates.length,
    verdictCount: result.verdicts.length,
    validatedBatches: result.manifest.batches.length,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  expectedRun,
  ensureRun,
  validatedBatch,
  pendingBatches,
  runPool,
};
