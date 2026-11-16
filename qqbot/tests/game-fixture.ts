import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { loadGameFactory } from '../src/game-loader.ts';
import type { Game as GameHost } from '../src/game-api.ts';
import type { Game, GameOptions, Player } from './game-domain.ts';
export type { Player } from './game-domain.ts';

export interface TestWorld {
  bosses: Array<{ name: string; realm: number; hp: number; maxHp: number; mp: number; attack: number; money: number }>;
  bossGeneratedAt: number | null;
}

export interface TestEngine {
  createGame: (options: GameOptions) => Game & { host: GameHost };
  openStore: (databasePath: string) => {
    save(groupId: string, player: Player): void;
    getWorld(groupId: string): TestWorld;
    saveWorld(groupId: string, world: TestWorld): void;
    close(): void;
  };
  data: { realms: Array<{ exp: number }> };
  encounters: { boss: { names: string[]; multipliers: { hp: number; mp: number; attack: number; money: number } } };
  stats: (player: Player) => { maxHp: number; maxMp: number };
}

const configured = process.env.QQBOT_TEST_ENGINE_DIRECTORY;
if (!configured || !isAbsolute(configured) || !existsSync(join(configured, 'engine.js'))) {
  throw new Error('QQ game tests require the real external engine. Set QQBOT_TEST_ENGINE_DIRECTORY to its absolute directory containing engine.js; no bundled fixture or fallback is used.');
}
export const testEngineDirectory = configured;

async function openEngine(sandboxRoot: string): Promise<TestEngine> {
  const directory = await realpath(testEngineDirectory);
  await loadGameFactory(directory, sandboxRoot);
  const require = createRequire(join(directory, 'engine.js'));
  const { createGame } = require(join(directory, 'engine.js')) as Pick<TestEngine, 'createGame'>;
  const { openStore } = require(join(directory, 'store.js'));
  const { data, stats } = require(join(directory, 'rules.js'));
  const encounters = require(join(directory, 'encounter-data.json'));
  return { createGame, openStore, data, stats, encounters };
}
let engine: Promise<TestEngine> | undefined;
export function testEngine(sandboxRoot: string) {
  return engine ??= openEngine(sandboxRoot);
}
