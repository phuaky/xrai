import { describe, it, expect } from 'bun:test';
import refresh from '../benchmarks/prepare-current-sequence-refresh-x.js';

describe('combined sequence refresh inputs', () => {
  it('canonicalizes a candidate triple independent of row order', () => {
    expect(refresh.tripleKey(['3', '1', '2'])).toBe('1|2|3');
    expect(refresh.tripleKey(['2', '3', '1'])).toBe('1|2|3');
  });
});
