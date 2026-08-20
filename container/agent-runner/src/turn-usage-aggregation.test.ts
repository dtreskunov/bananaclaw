import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { sumFxUsageFacts, readFxUsageSince } from './providers/fx';
import { sumOpenCodeUsage } from './providers/opencode';

describe('sumOpenCodeUsage', () => {
  // The bug this replaced: only the final assistant message was recorded, so a
  // tool-calling turn reported ~18% of what it actually cost.
  it('sums every assistant message in the turn', () => {
    const total = sumOpenCodeUsage([
      { cost_usd: 0.005775, input_tokens: 18626, output_tokens: 60, cache_read_tokens: 1920, cache_write_tokens: 0, model: 'MiniMax-M3' },
      { cost_usd: 0.00126138, input_tokens: 23, output_tokens: 15, cache_read_tokens: 20608, cache_write_tokens: 0, model: 'MiniMax-M3' },
    ]);
    expect(total).not.toBeNull();
    expect(total!.cost_usd).toBeCloseTo(0.00703638, 8);
    expect(total!.input_tokens).toBe(18649);
    expect(total!.output_tokens).toBe(75);
    expect(total!.cache_read_tokens).toBe(22528);
    expect(total!.model).toBe('MiniMax-M3');
  });

  it('skips messages with no usage snapshot', () => {
    const total = sumOpenCodeUsage([
      undefined,
      { cost_usd: 1, input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5, reasoning_tokens: 6, model: 'm' },
    ]);
    expect(total!.input_tokens).toBe(2);
    expect(total!.reasoning_tokens).toBe(6);
  });

  it('returns null when the turn produced no usage at all', () => {
    expect(sumOpenCodeUsage([])).toBeNull();
    expect(sumOpenCodeUsage([undefined, undefined])).toBeNull();
  });
});

describe('sumFxUsageFacts', () => {
  // fx reports input_tokens inclusive of cache reads; the DB column is the
  // uncached remainder, so the two must not be double-counted.
  it('subtracts cache reads out of the input total', () => {
    const total = sumFxUsageFacts([
      { model: 'minimax/minimax-m3', input_tokens: 11682, output_tokens: 341, cache_read_tokens: 112, total_cost: 0.00388692 },
      { model: 'minimax/minimax-m3', input_tokens: 11827, output_tokens: 149, cache_read_tokens: 11681, total_cost: 0.00092346 },
    ]);
    expect(total!.input_tokens).toBe(11570 + 146);
    expect(total!.cache_read_tokens).toBe(11793);
    expect(total!.output_tokens).toBe(490);
    expect(total!.cost_usd).toBeCloseTo(0.00481038, 8);
    expect(total!.model).toBe('minimax/minimax-m3');
  });

  it('never reports negative input when cache reads exceed the input count', () => {
    const total = sumFxUsageFacts([{ input_tokens: 10, cache_read_tokens: 99 }]);
    expect(total!.input_tokens).toBe(0);
  });

  it('returns null with no generations', () => {
    expect(sumFxUsageFacts([])).toBeNull();
  });
});

describe('fx usage log reading', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-usage-'));
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.fx'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function gen(cost: number): string {
    return JSON.stringify({
      schema_version: 1,
      kind: 'generation',
      fact: { model: 'm', input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, total_cost: cost },
    }) + '\n';
  }

  it('counts only generations appended after the offset', () => {
    const log = path.join(home, '.fx', 'usage.jsonl');
    fs.writeFileSync(log, JSON.stringify({ kind: 'coverage', started_at_ms: 1 }) + '\n' + gen(0.5));
    const offset = fs.statSync(log).size;
    fs.appendFileSync(log, gen(0.25) + gen(0.25));

    const usage = readFxUsageSince(offset);
    expect(usage!.cost_usd).toBeCloseTo(0.5, 8);
    expect(usage!.output_tokens).toBe(20);
  });

  it('returns null when nothing was appended', () => {
    const log = path.join(home, '.fx', 'usage.jsonl');
    fs.writeFileSync(log, gen(0.5));
    expect(readFxUsageSince(fs.statSync(log).size)).toBeNull();
  });

  it('treats a missing log as no usage rather than an error', () => {
    expect(readFxUsageSince(0)).toBeNull();
  });

  it('ignores a half-written trailing line', () => {
    const log = path.join(home, '.fx', 'usage.jsonl');
    fs.writeFileSync(log, '');
    fs.appendFileSync(log, gen(0.25) + '{"kind":"generation","fact":{"tot');
    expect(readFxUsageSince(0)!.cost_usd).toBeCloseTo(0.25, 8);
  });
});
