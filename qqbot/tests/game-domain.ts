export interface GameEvent {
  groupId: string;
  userId: string;
  text: string;
  nickname?: string;
  targetId?: string;
  answer?: boolean;
}

export interface ParsedGameInput {
  text: string;
}

export type GameReviewKind = 'adventure' | 'rift';

export type GameReviewRequest = {
  requestId: string;
  revision: number;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
} & ({ kind: 'adventure'; phase: 'scene' | 'action'; source: 'adventure' | 'cultivation'; cultivationKind: 'insight' | 'deviation' | null } | { kind: 'rift' });


export interface GameLootItem {
  id: string;
  name: string;
  kind: 'herb' | 'weapon' | 'armor' | 'technique' | 'skill';
  rank: number;
  count: number;
}

export interface GameFact {
  id: string;
  type: string;
  itemGains?: GameLootItem[];
  lootMessage?: string;
  [detail: string]: string | number | boolean | null | GameLootItem[] | undefined;
}


export interface Mission {
  name: string;
  kind: string;
  difficulty: string;
  rate: number;
  minutes: number;
  exp: number;
  itemId: string | null;
}

interface ActivityBase {
  label: string;
  startedAt: number;
  finishCommand: string;
}

export type GameActivity =
  | (ActivityBase & { kind: 'closing' })
  | (ActivityBase & { kind: 'mission'; readyAt: number; task: Mission })
  | (ActivityBase & { kind: 'rift'; rift: { name: string; rank: number; time: number } });

export interface RiftAdventure {
  id: string;
  storyId?: string;
  endingId?: string;
  revision: number;
  round: number;
  maxRounds: number;
  status: 'awaiting' | 'judging' | 'settled' | 'cancelled';
  score: number;
  scene: { id: string; title: string; description: string; choices?: string[] };
  history: Array<{ sceneId: string; action: string; outcome: 'success' | 'mixed' | 'failure'; reason: string; narrative: string }>;
  pendingAction: string | null;
  receipts: Array<{ revision: number; message: string }>;
  itemGains?: GameLootItem[];
  promptMessage: string;
  lastMessage: string;
}

export interface GameStory {
  id: string;
  title: string;
  npc: string;
  opening: string;
  mystery: string;
  motifs: string[];
  minRealm: number;
}

export interface StoryBeat {
  scene: { id: string; title: string; description: string };
  action: string;
  feedback: string;
  outcome: 'success' | 'mixed' | 'failure';
}

export interface GameAdventureScene {
  id: string;
  title: string;
  description: string;
  clues?: string[];
  choices?: string[];
}

export interface Adventure {
  id: string;
  revision: number;
  source: 'adventure' | 'cultivation';
  cultivationKind: 'insight' | 'deviation' | null;
  status: 'generating' | 'awaiting' | 'judging' | 'settled';
  startedAt: number;
  story: GameStory;
  storyVisits: number;
  storyBeats: StoryBeat[];
  scene: GameAdventureScene | null;
  options: Array<{
    id: '1' | '2';
    label: '稳妥' | '冒险';
    risk: string;
    successRate: number;
    expGain: number;
    moneyGain: number;
    failureExpGain: number;
    maxHpLoss: number;
  }>;
  promptMessage: string;
  lastMessage: string;
  pendingAction: string | null;
  receipts: Array<{ revision: number; message: string }>;
  itemGains?: GameLootItem[];
  reviewRequest: GameReviewRequest | null;
  selectedOption?: string;
  resultMessage?: string;
}

export type PetSpeciesId = 'qingling' | 'xuanjia' | 'yunling';

export interface PetState {
  activeId: PetSpeciesId | null;
  owned: Partial<Record<PetSpeciesId, { exp: number }>>;
}

export interface PetGuidance {
  active: {
    id: PetSpeciesId;
    name: string;
    level: number;
    attackRate: number;
    attackMin: number;
    defenseRate: number;
    hpRate: number;
    mpRate: number;
  } | null;
  catalog: Array<{ id: PetSpeciesId; name: string; cost: number; description: string }>;
  feedCost: 500;
  feedExp: 100;
  maxLevel: 10;
  commands: string[];
}

export interface PendingDismantle {
  id: string;
  itemId: string;
  count: number;
  moneyGain: number;
  expiresAt: number;
}

export interface Player {
  userId: string;
  name: string;
  root: { type: string; name: string; speed: number };
  realm: number;
  exp: number;
  money: number;
  hp: number;
  mp: number;
  equipment: { weapon: string | null; armor: string | null; technique: string | null; skill: string | null };
  inventory: Record<string, number>;
  pendingDismantle: PendingDismantle | null;
  pets: PetState;
  activity: GameActivity | null;
  breakthroughAt: number | null;
  breakthroughBonus: number;
  pillBonus: number;
  giftClaims: number;
  giftAt: number | null;
  board: { date: string; entries: Mission[] } | null;
  daily: {
    date: string;
    refreshes: number;
    pillUses: Record<string, number>;
    sectTasks: number;
    sectElixirClaimed: boolean;
    dualCultivations: number;
  };
  createdAt: number;
  trainingAt?: number;
  attackBonus: number;
  pillTotals: Record<string, number>;
  bossPoints: number;
  lastDuelAt: number | null;
  signDate?: string;
  adventure: Adventure | null;
  adventureReadyAt: number | null;
  cultivationEventAt?: number | null;
  storyThread: { id: string; visits: number; beats: StoryBeat[] } | null;
  riftAdventure: RiftAdventure | null;
  journey: GameFact[];
  journeySequence: number;
  bank: { balance: number; level: number; lastSettledAt: number } | null;
  estate: { name: string | null; gardenPlots: number; gardenAt: number; minePlots: number; mineAt: number } | null;
  alchemy: {
    collectionLevel: number;
    fireLevel: number;
    exp: number;
    records: Record<string, { name: string; count: number }>;
    recommendations?: Array<{
      pillId: string;
      mainId: string;
      mainCount: number;
      catalystId: string;
      catalystCount: number;
      auxiliaryId: string;
      auxiliaryCount: number;
      furnaceId: string;
    }>;
    exam: { points: number; current: Record<string, unknown> | null };
  };
  romance: {
    favor: Record<string, number>;
    completedSpecial: Record<string, boolean>;
    task: { fairyId: string; day: string; missionId: string; special: boolean; cost: number; acceptedAt: number } | null;
    completedDay: string | null;
    confessionDates: Record<string, string>;
    partnerFairyId: string | null;
  };
  sectId: number | null;
  sectPosition: number | null;
  sectContribution: number;
  attackPractice: number;
  sectTask: Record<string, unknown> | null;
  lastSectTaskRefreshAt: number | null;
  lastStealAt: number | null;
  position: string;
}

export interface GameChoice {
  label: string;
  command: string;
}

export interface GameGuidance {
  cultivation: { mode: 'passive' | 'closing' | 'busy'; expCap: number | null; hpCap: number; expPerMinute: number };
  newcomerGift: { claimed: boolean; automaticOnJoin: boolean; firstGiftAmount: number };
  breakthrough: { nextRealm: string; requiredExp: number; successRate: number; cooldownUntil: number | null; ready: boolean } | null;
  pets: PetGuidance;
}

export type GameSceneImage = {
  adventureId: string;
  sceneId: string;
  title: string;
  description: string;
} & ({ kind: 'rift'; round: number } | { kind: 'adventure'; revision: number });

export interface GameResult {
  handled: boolean;
  message: string;
  choices?: GameChoice[];
  sceneImage?: GameSceneImage;
  reviewRequest?: GameReviewRequest;
  error?: 'invalid_review' | 'judge_failed';
}

export interface GameReviewEvent {
  groupId: string;
  userId: string;
  kind: GameReviewKind;
  requestId: string;
  revision: number;
  review: unknown;
}

export interface GameOptions {
  databasePath: string;
  now?: () => number;
  random?: () => number;
  judge?: (request: GameReviewRequest) => unknown | Promise<unknown>;
}

export interface Game {
  parseInput(event: GameEvent): ParsedGameInput | null;
  handleCommand(event: GameEvent): GameResult;
  handleMessage(event: GameEvent): Promise<GameResult>;
  resolveReview(event: GameReviewEvent): GameResult;
  getPlayer(groupId: string, userId: string): Player | null;
  getPlayers(groupId: string): Player[];
  getGuidance?(groupId: string, userId: string): GameGuidance | null;
  // Targeted choices also include the selected group players in their readonly snapshot.
  getChoiceState(groupId: string, userId: string, targetIds?: readonly string[]): string;
  close(): void;
}

