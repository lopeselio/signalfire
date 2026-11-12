export * from './types.ts';
export * from './measure.ts';
export * from './quote.ts';
export * from './gpu.ts';
export * from './signature.ts';
export * from './verify.ts';

/** What a verified badge proves, and what it doesn't (shown in the UI and printed by `pnpm verify`). */
export const PROVES =
  'The key that signed this reply lives inside an Intel TDX TEE with NVIDIA GPUs in confidential mode, running the measured container shown, and that TEE answered this check’s fresh nonce just now. The signature covers this exact request and reply.';
export const DOES_NOT_PROVE =
  'It does not prove that this reply came from the same serving instance as the report: instances of a model share one signing key (docs.near.ai). It says nothing about whether the reply is wise, and the model decides nothing here.';
