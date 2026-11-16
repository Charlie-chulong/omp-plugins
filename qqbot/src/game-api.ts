export interface GameEvent {
  groupId: string;
  userId: string;
  text: string;
  nickname?: string;
  scope?: 'group' | 'c2c';
  targetIds?: readonly string[];
  excludedTargetIds?: readonly string[];
}

export type GameAction =
  | { type: 'game_action'; command: string; continue?: boolean }
  | { type: 'game_answer'; answer: string };

export interface ParsedGameInput { text: string }
export interface GameChoice { label: string; command: string }

export interface GameReviewRequest {
  kind: string;
  requestId: string;
  revision: number;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  label: string;
  announce: boolean;
  failureMessage: string;
}

export interface GameSceneImage {
  sceneId: string;
  title: string;
  description: string;
  token: string;
  image: { system: string; prompt: string; width: number; height: number };
  progressMessage: string;
}

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
  kind: string;
  requestId: string;
  revision: number;
  review: unknown;
}

export interface GameOptions {
  databasePath: string;
  now?: () => number;
  random?: () => number;
}

export interface Game {
  protocol: { version: string; prompt: string };
  parseInput(event: GameEvent): ParsedGameInput | null;
  handleMessage(event: GameEvent): Promise<GameResult>;
  executeAction(event: GameEvent, action: GameAction): Promise<GameResult>;
  context(event: GameEvent, results?: readonly GameResult[]): string;
  feedback(result: GameResult): string;
  resolveReview(event: GameReviewEvent): GameResult;
  getChoiceState(groupId: string, userId: string, choices?: readonly GameChoice[]): string;
  getSceneState(groupId: string, userId: string, scene: GameSceneImage): 'active' | 'pending' | 'obsolete';
  inspect(event: GameEvent): { parsed: ParsedGameInput | null; player: unknown | null };
  close(): void;
}
