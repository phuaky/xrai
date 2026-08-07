import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sha256, validateSequenceBuildProvenance } from '../benchmarks/full-corpus-audit-x.js';
import {
  validateCandidate,
  validateVerdict,
  loadPrepared,
  loadRun,
  validateCandidateOutputFile,
  validateOutputs,
  build,
} from '../benchmarks/sequence-candidate-audit-x.js';

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('sequence candidate Luna reconciliation', () => {
  it('strictly validates candidate and verdict schemas', () => {
    const candidate = {
      candidateId: 'candidate-0000',
      minSimilarity: 0.8,
      rows: [1, 2, 3].map((id) => ({
        id: String(id), text: `claim ${id}`, author: 'a', media: 'text', timestamp: id,
        dwellMs: 0, exposureState: 'shown-unread', lunaTopic: 'topic', lunaClaimCluster: 'claim',
      })),
    };
    expect(validateCandidate(candidate, 'candidate')).toEqual(candidate);
    expect(() => validateCandidate({ ...candidate, action: 'show' }, 'candidate')).toThrow('schema');
    const steps = candidate.rows.map((row, index) => ({
      id: row.id,
      importance: 'normal',
      topic: 'topic',
      contentType: 'post',
      novelty: index === 0 ? 'new-signal' : 'repeat',
      funnelRisk: false,
      standaloneValue: true,
      confidence: 0.9,
      reason: 'Chronological fixture',
    }));
    expect(validateVerdict({
      candidateId: 'candidate-0000', sameClaim: true, claimCluster: 'claim',
      confidence: 0.9, reason: 'Same event', steps,
    }, 'verdict', candidate).sameClaim).toBe(true);
    expect(() => validateVerdict({
      candidateId: 'candidate-0000', sameClaim: false, claimCluster: 'claim',
      confidence: 0.9, reason: 'Different claims', steps: [],
    }, 'verdict', candidate)).toThrow('rejected');
    expect(() => validateVerdict({
      candidateId: 'candidate-0000', sameClaim: true, claimCluster: ' ReJeCtEd ',
      confidence: 0.9, reason: 'Contradiction', steps,
    }, 'verdict', candidate)).toThrow('approved verdict cannot be rejected');
  });

  it('builds at least 100 checked scenarios only from approved disjoint triples', () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'rai-sequence-candidates-'));
    const candidateDir = join(auditDir, 'sequence-candidates');
    mkdirSync(join(candidateDir, 'batches'), { recursive: true });
    mkdirSync(join(candidateDir, 'prompts'), { recursive: true });
    mkdirSync(join(candidateDir, 'outputs'), { recursive: true });

    const corpus = [];
    const originalVerdicts = [];
    const candidates = [];
    const candidateVerdicts = [];
    for (let candidateIndex = 0; candidateIndex < 100; candidateIndex++) {
      const candidateRows = [];
      for (let step = 0; step < 3; step++) {
        const id = String(candidateIndex * 3 + step + 1);
        const timestamp = candidateIndex * 10 + step;
        corpus.push({
          id, text: `claim ${candidateIndex} version ${step}`, author: 'a', media: 'text',
          decision: 'shown', source: 'model', timestamp, dwellMs: step === 0 ? 1000 : 0,
          exposureState: step === 0 ? 'read' : 'shown-unread', truncated: false,
        });
        originalVerdicts.push({
          id, importance: 'normal', topic: 'topic', contentType: 'post', claimCluster: `first-pass-${candidateIndex}`,
          novelty: step === 0 ? 'new-signal' : 'repeat', funnelRisk: false, standaloneValue: true,
          confidence: 0.9, reason: 'fixture',
        });
        candidateRows.push({
          id, text: `claim ${candidateIndex} version ${step}`, author: 'a', media: 'text', timestamp,
          dwellMs: step === 0 ? 1000 : 0, exposureState: step === 0 ? 'read' : 'shown-unread',
          lunaTopic: 'topic', lunaClaimCluster: `first-pass-${candidateIndex}`,
        });
      }
      const candidateId = `candidate-${String(candidateIndex).padStart(4, '0')}`;
      candidates.push({ candidateId, minSimilarity: 0.8, rows: candidateRows });
      candidateVerdicts.push({
        candidateId, sameClaim: true, claimCluster: `canonical-${candidateIndex}`,
        confidence: 0.9, reason: 'Same fixture claim',
        steps: candidateRows.map((row, step) => ({
          id: row.id,
          importance: 'normal',
          topic: 'topic',
          contentType: 'post',
          novelty: step === 0 ? 'new-signal' : 'repeat',
          funnelRisk: false,
          standaloneValue: true,
          confidence: 0.9,
          reason: 'Sequence-aware fixture',
        })),
      });
    }

    const corpusBytes = Buffer.from(jsonl(corpus));
    const originalVerdictBytes = Buffer.from(jsonl(originalVerdicts));
    writeFileSync(join(auditDir, 'corpus.jsonl'), corpusBytes);
    writeFileSync(join(auditDir, 'luna-verdicts.jsonl'), originalVerdictBytes);
    const candidateBytes = Buffer.from(jsonl(candidates));
    const candidateIds = candidates.map((row) => row.candidateId);
    const candidateIdBytes = Buffer.from(candidateIds.toSorted().join('\n') + '\n');
    const prompt = 'fixture prompt\n';
    writeFileSync(join(candidateDir, 'candidates.jsonl'), candidateBytes);
    writeFileSync(join(candidateDir, 'batches/batch-0000.jsonl'), candidateBytes);
    writeFileSync(join(candidateDir, 'prompts/batch-0000.txt'), prompt);
    const outputPath = join(candidateDir, 'outputs/batch-0000.jsonl');
    writeFileSync(outputPath, jsonl(candidateVerdicts));
    writeFileSync(join(candidateDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'rai-x-sequence-candidate-audit',
      corpusSha256: sha256(corpusBytes),
      verdictsSha256: sha256(originalVerdictBytes),
      embeddingModel: 'all-minilm:latest',
      embeddingInput: 'fixture',
      similarityThreshold: 0.8,
      maxIdUses: 0,
      excludedIds: [],
      excludedIdSha256: sha256(Buffer.from('')),
      seedCandidateCount: 0,
      candidateCount: 100,
      candidatesSha256: sha256(candidateBytes),
      batches: [{
        index: 0,
        file: 'batches/batch-0000.jsonl',
        promptFile: 'prompts/batch-0000.txt',
        outputFile: 'outputs/batch-0000.jsonl',
        validationFile: 'outputs/batch-0000.validated.json',
        count: 100,
        sha256: sha256(candidateBytes),
        candidateIdSha256: sha256(candidateIdBytes),
        promptSha256: sha256(Buffer.from(prompt)),
        candidateIds,
      }],
    }));
    writeFileSync(join(candidateDir, 'run.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'rai-x-sequence-candidate-luna-run',
      model: 'gpt-5.5',
      reasoning: 'medium',
    }));
    const prepared = loadPrepared(auditDir);
    const run = loadRun(candidateDir);
    const validated = validateCandidateOutputFile(
      outputPath,
      prepared.manifest.batches[0],
      prepared.batchCandidates.get('batches/batch-0000.jsonl'),
      run,
    );
    writeFileSync(
      join(candidateDir, 'outputs/batch-0000.validated.json'),
      JSON.stringify(validated.record) + '\n',
    );

    expect(validateOutputs(auditDir, false).verdicts).toHaveLength(100);
    const report = build(auditDir);
    expect(report.appliedCount).toBe(100);
    expect(report.scenarioCount).toBe(100);
    expect(report.itemCount).toBe(300);
    const built = validateSequenceBuildProvenance(auditDir);
    expect(built.artifact.scenariosSha256).toBe(report.scenariosSha256);

    candidateVerdicts[99] = {
      candidateId: 'candidate-0099',
      sameClaim: false,
      claimCluster: 'rejected',
      confidence: 0.99,
      reason: 'Different claims',
      steps: [],
    };
    writeFileSync(outputPath, jsonl(candidateVerdicts));
    const rejectedValidation = validateCandidateOutputFile(
      outputPath,
      prepared.manifest.batches[0],
      prepared.batchCandidates.get('batches/batch-0000.jsonl'),
      run,
    );
    writeFileSync(
      join(candidateDir, 'outputs/batch-0000.validated.json'),
      JSON.stringify(rejectedValidation.record) + '\n',
    );
    expect(() => build(auditDir)).toThrow('at least 100 scenarios');
  });
});
