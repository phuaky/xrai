#!/usr/bin/env python3

"""Prepare semantic triples for a second offline Luna claim check.

The full-corpus judge labels each 100-row batch independently, so equivalent
claimCluster wording can drift across batches. This local-only step uses the
same all-minilm embedding model as runtime to propose likely same-claim triples.
Luna must still approve every triple; vector similarity never becomes truth.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np

PROMPT = """You are Luna, reconciling candidate chronological X sequences for rai's offline evaluation.

Judge each candidate independently. sameClaim is true only when all three tweets concern the same underlying factual claim, event, release, benchmark, opportunity, or funnel offer. A shared broad topic, author, content format, meme, reaction style, or product name is not enough. Reject generic reactions and media-only similarities. Different wording and commentary may remain the same claim; a materially different event or assertion is not.

For every approved candidate, judge each tweet in chronological context using only earlier tweets in that candidate as prior claim history. The first tweet is new-signal. A later tweet about the approved same claim is meaningful-update only when facts, numbers, evidence, release state, outage state, benchmark results, or an actionable opportunity materially changed; reinforcement independently supports the same claim without changing it; repeat adds no meaningful delta. A later approved step cannot be new-signal.

Output JSONL only, exactly one object per candidateId, with no markdown or prose. Every object must contain exactly:
{"candidateId":"candidate-0000","sameClaim":true,"claimCluster":"stable-canonical-label","confidence":0.0,"reason":"concise same-claim reason","steps":[{"id":"<tweet id>","importance":"critical|normal","topic":"concise topic","contentType":"concise type","novelty":"new-signal|meaningful-update|reinforcement|repeat","funnelRisk":false,"standaloneValue":true,"confidence":0.0,"reason":"concise chronological judgment"}]}

Rules:
- When sameClaim is true, steps must contain exactly the candidate's three tweet IDs in input order.
- importance is independent of novelty; critical means an opportunity or development the user would most regret missing.
- funnelRisk is true when the tweet tries to move the reader to a comment, DM, subscription, community, course, purchase, or external continuation.
- standaloneValue is true only when the supplied tweet itself delivers useful information before that request.
- The top-level confidence measures same-claim confidence. Each step confidence measures confidence in that step's labels.
- When sameClaim is false, claimCluster must be exactly "rejected" and steps must be an empty array.
- Never emit tweet actions or knownState. Verify the candidateId and step-ID sets exactly before answering.
"""

EXCLUDED_LABEL_TERMS = (
    "ambiguous", "empty", "generic reaction", "media-only", "media only",
    "no-text", "no text", "image reaction", "video reaction",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def jsonl(rows) -> bytes:
    text = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        for row in rows
    ) + "\n"
    return text.encode("utf-8", errors="backslashreplace")


def read_jsonl(file: Path):
    rows = []
    lines = file.read_text().split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            raise ValueError(f"{file}:{line_number}: blank JSONL row")
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{file}:{line_number}: {error}") from error
        rows.append(row)
    return rows


def embed(texts, model: str, ollama_url: str, batch_size: int) -> np.ndarray:
    vectors = []
    for offset in range(0, len(texts), batch_size):
        batch = texts[offset:offset + batch_size]
        request = Request(
            f"{ollama_url}/api/embed",
            data=json.dumps({"model": model, "input": batch, "truncate": True}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=60) as response:
            payload = json.load(response)
        embeddings = payload.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(batch):
            raise ValueError(f"embedding response covered {len(embeddings or [])}/{len(batch)} texts")
        vectors.extend(embeddings)
        print(f"embedded {min(offset + len(batch), len(texts))}/{len(texts)}", flush=True)
    matrix = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise ValueError("embedding response contained a zero vector")
    return matrix / norms


def eligible(corpus_row, verdict) -> bool:
    if corpus_row.get("decision") != "shown":
        return False
    text = str(corpus_row.get("text") or "").strip()
    if len(text) < 20:
        return False
    label = f"{verdict.get('claimCluster', '')} {verdict.get('topic', '')}".lower()
    return not any(term in label for term in EXCLUDED_LABEL_TERMS)


def embedding_input(corpus_row, verdict) -> str:
    return (
        f"{verdict['claimCluster']}. "
        f"{verdict['topic']}. "
        f"{corpus_row['text']}"
    )


def candidate_row(corpus_row, verdict):
    return {
        "id": corpus_row["id"],
        "text": corpus_row["text"],
        "author": corpus_row["author"],
        "media": corpus_row["media"],
        "timestamp": corpus_row["timestamp"],
        "dwellMs": corpus_row["dwellMs"],
        "exposureState": corpus_row["exposureState"],
        "lunaTopic": verdict["topic"],
        "lunaClaimCluster": verdict["claimCluster"],
    }


def candidate_options(
    index: int,
    similarities: np.ndarray,
    top_k: int,
    threshold: float,
    alternatives: int,
):
    if index < 2:
        return []
    row = similarities[index, :index]
    count = min(top_k, index)
    nearest = np.argpartition(row, -count)[-count:]
    nearest = nearest[np.argsort(row[nearest])[::-1]]
    options = []
    for left_pos in range(len(nearest)):
        left = int(nearest[left_pos])
        if row[left] < threshold:
            break
        for right_pos in range(left_pos + 1, len(nearest)):
            right = int(nearest[right_pos])
            score = min(float(row[left]), float(row[right]), float(similarities[left, right]))
            if score >= threshold:
                options.append((score, left, right, index))
    options.sort(reverse=True)
    return options[:alternatives]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-dir", default="data/luna-audit-x")
    parser.add_argument("--model", default=os.environ.get("RAI_EMBEDDING_MODEL", "all-minilm:latest"))
    parser.add_argument("--ollama-url", default=os.environ.get("OLLAMA_URL", "http://localhost:11434"))
    parser.add_argument("--threshold", type=float, default=0.58)
    parser.add_argument("--target", type=int, default=400)
    parser.add_argument("--top-k", type=int, default=12)
    parser.add_argument("--alternatives", type=int, default=8)
    parser.add_argument("--max-id-uses", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--seed-candidates")
    parser.add_argument("--exclude-ids")
    args = parser.parse_args()
    if args.alternatives < 1:
        raise ValueError("--alternatives must be positive")
    if args.max_id_uses < 0:
        raise ValueError("--max-id-uses must be non-negative")

    audit_dir = Path(args.audit_dir).resolve()
    corpus = read_jsonl(audit_dir / "corpus.jsonl")
    verdicts = read_jsonl(audit_dir / "luna-verdicts.jsonl")
    corpus_by_id = {row["id"]: row for row in corpus}
    verdict_by_id = {row["id"]: row for row in verdicts}
    if (
        len(corpus_by_id) != len(corpus)
        or len(verdict_by_id) != len(verdicts)
        or set(verdict_by_id) != set(corpus_by_id)
    ):
        raise ValueError("corpus and Luna verdict ID sets differ")

    excluded_ids = set()
    if args.exclude_ids:
        exclude_path = Path(args.exclude_ids).resolve()
        lines = exclude_path.read_text().split("\n")
        excluded_ids = {line.strip() for line in lines if line.strip()}
        if any(not value.isdigit() for value in excluded_ids):
            raise ValueError("--exclude-ids must contain digit-only tweet IDs")

    all_retained = [row for row in corpus if eligible(row, verdict_by_id[row["id"]])]
    all_retained_ids = {row["id"] for row in all_retained}
    retained = [row for row in all_retained if row["id"] not in excluded_ids]
    matrix = embed([
        embedding_input(row, verdict_by_id[row["id"]])
        for row in retained
    ], args.model, args.ollama_url, 128)
    similarities = matrix @ matrix.T

    seed_candidates = (
        read_jsonl(Path(args.seed_candidates).resolve())
        if args.seed_candidates else []
    )
    seen_triples = set()
    id_uses = {}
    canonical_seeds = []
    for number, candidate in enumerate(seed_candidates):
        expected_id = f"candidate-{number:04d}"
        if candidate.get("candidateId") != expected_id:
            raise ValueError(f"seed candidate {number} must be {expected_id}")
        rows = candidate.get("rows")
        if not isinstance(rows, list) or len(rows) != 3:
            raise ValueError(f"{expected_id} must contain three rows")
        row_ids = [row.get("id") for row in rows]
        ids = set(row_ids)
        if len(ids) != 3 or not ids.issubset(all_retained_ids):
            raise ValueError(f"{expected_id} has invalid or duplicate IDs")
        triple_key = tuple(sorted(ids))
        if triple_key in seen_triples:
            raise ValueError(f"{expected_id} duplicates a seeded triple")
        rebuilt_rows = [
            candidate_row(corpus_by_id[row_id], verdict_by_id[row_id])
            for row_id in row_ids
        ]
        if any(
            rebuilt_rows[index]["timestamp"] > rebuilt_rows[index + 1]["timestamp"]
            for index in range(2)
        ):
            raise ValueError(f"{expected_id} is not chronological in the current corpus")
        similarity = candidate.get("minSimilarity")
        if not isinstance(similarity, (int, float)) or not -1 <= similarity <= 1:
            raise ValueError(f"{expected_id} has invalid minSimilarity")
        canonical_seeds.append({
            "candidateId": expected_id,
            "minSimilarity": similarity,
            "rows": rebuilt_rows,
        })
        seen_triples.add(triple_key)
        for row_id in row_ids:
            id_uses[row_id] = id_uses.get(row_id, 0) + 1
    seed_candidates = canonical_seeds

    proposed = []
    for index in range(len(retained)):
        proposed.extend(candidate_options(
            index,
            similarities,
            args.top_k,
            args.threshold,
            args.alternatives,
        ))
    proposed.sort(reverse=True)

    selected = []
    for score, left, right, current in proposed:
        indexes = sorted((left, right, current))
        row_ids = [retained[index]["id"] for index in indexes]
        triple_key = tuple(sorted(row_ids))
        if triple_key in seen_triples:
            continue
        if args.max_id_uses and any(
            id_uses.get(row_id, 0) >= args.max_id_uses
            for row_id in row_ids
        ):
            continue
        seen_triples.add(triple_key)
        for row_id in row_ids:
            id_uses[row_id] = id_uses.get(row_id, 0) + 1
        selected.append((score, indexes))
        if len(seed_candidates) + len(selected) >= args.target:
            break
    total_candidates = len(seed_candidates) + len(selected)
    if total_candidates < 100:
        raise ValueError(
            f"only {total_candidates} candidate triples; lower --threshold"
        )

    out = audit_dir / "sequence-candidates"
    (out / "batches").mkdir(parents=True, exist_ok=True)
    (out / "prompts").mkdir(parents=True, exist_ok=True)
    (out / "outputs").mkdir(parents=True, exist_ok=True)

    candidates = list(seed_candidates)
    for score, indexes in selected:
        rows = []
        for index in indexes:
            corpus_row = retained[index]
            verdict = verdict_by_id[corpus_row["id"]]
            rows.append(candidate_row(corpus_row, verdict))
        candidates.append({
            "candidateId": f"candidate-{len(candidates):04d}",
            "minSimilarity": round(score, 6),
            "rows": rows,
        })

    all_bytes = jsonl(candidates)
    (out / "candidates.jsonl").write_bytes(all_bytes)
    manifest_batches = []
    for offset in range(0, len(candidates), args.batch_size):
        batch = candidates[offset:offset + args.batch_size]
        index = offset // args.batch_size
        stem = f"batch-{index:04d}"
        batch_bytes = jsonl(batch)
        batch_file = f"batches/{stem}.jsonl"
        prompt_file = f"prompts/{stem}.txt"
        output_file = f"outputs/{stem}.jsonl"
        validation_file = f"outputs/{stem}.validated.json"
        (out / batch_file).write_bytes(batch_bytes)
        prompt = (
            PROMPT + "\n" +
            f"Candidate file: {batch_file}\n" +
            f"Candidate SHA-256: {sha256(batch_bytes)}\n" +
            f"Expected verdict count: {len(batch)}\n" +
            "Read the candidate file and emit the required JSONL.\n"
        )
        (out / prompt_file).write_text(prompt)
        candidate_ids = [row["candidateId"] for row in batch]
        id_bytes = ("\n".join(sorted(candidate_ids)) + "\n").encode()
        manifest_batches.append({
            "index": index,
            "file": batch_file,
            "promptFile": prompt_file,
            "outputFile": output_file,
            "validationFile": validation_file,
            "count": len(batch),
            "sha256": sha256(batch_bytes),
            "candidateIdSha256": sha256(id_bytes),
            "promptSha256": sha256(prompt.encode()),
            "candidateIds": candidate_ids,
        })

    manifest = {
        "schemaVersion": 1,
        "kind": "rai-x-sequence-candidate-audit",
        "corpusSha256": sha256((audit_dir / "corpus.jsonl").read_bytes()),
        "verdictsSha256": sha256((audit_dir / "luna-verdicts.jsonl").read_bytes()),
        "embeddingModel": args.model,
        "embeddingInput": "luna-claim-topic-plus-tweet-text",
        "similarityThreshold": args.threshold,
        "maxIdUses": args.max_id_uses,
        "excludedIds": sorted(excluded_ids),
        "excludedIdSha256": sha256(
            (("\n".join(sorted(excluded_ids)) + "\n").encode())
            if excluded_ids else b""
        ),
        "seedCandidateCount": len(seed_candidates),
        "candidateCount": len(candidates),
        "candidatesSha256": sha256(all_bytes),
        "batches": manifest_batches,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({
        "retainedRows": len(retained),
        "excludedRows": len(all_retained) - len(retained),
        "candidateCount": len(candidates),
        "batches": len(manifest_batches),
        "minimumSimilarity": min(row["minSimilarity"] for row in candidates),
        "output": str(out),
    }, indent=2))


if __name__ == "__main__":
    main()
