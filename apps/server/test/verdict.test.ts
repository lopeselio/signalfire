import { describe, expect, it } from 'vitest';
import { parseVerdict, privateLines } from '../src/verdict.ts';

describe('private verdicts', () => {
  it('accepts exactly a score and the fixed phrases', () => {
    expect(parseVerdict('{"fit":4,"private_details":"support the profile","concern":"none"}')).toEqual({ fit: 4, private_details: 'support the profile', concern: 'none' });
  });
  it('refuses anything that could carry the private details', () => {
    expect(parseVerdict('{"fit":4,"private_details":"support the profile","concern":"none","note":"2,400 opens"}')).toBeNull();
    expect(parseVerdict('{"fit":4,"private_details":"6.2k followers","concern":"none"}')).toBeNull();
    expect(parseVerdict('{"fit":9,"private_details":"support the profile","concern":"none"}')).toBeNull();
    expect(parseVerdict('not json')).toBeNull();
  });
  it('writes the report lines the onchain hash covers', () => {
    expect(privateLines({ fit: 3, private_details: 'were not given', concern: 'none' }, 'ab')).toBe('\n\nprivate_verdict: {"fit":3,"private_details":"were not given","concern":"none"}\nprivate_commitment: ab');
  });
});
