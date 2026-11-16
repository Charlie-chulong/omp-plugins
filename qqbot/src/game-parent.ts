import type { OmpAgentHandle } from '@omp-desktop/client';

export async function gameParentConfiguration(parent: OmpAgentHandle) {
  const [snapshot, config] = await Promise.all([parent.refresh(), parent.configuration()]);
  if (!snapshot?.agent) throw new Error('QQ 游戏会话已不可用。');
  if (snapshot.agent.status === 'closed') {
    // Model configuration loads the original persisted session without a prompt.
    // Reuse its exact saved selection, including an unset provider default.
    const separator = config.provider.indexOf('/');
    await parent.setModel(separator === -1 ? null : config.provider.slice(separator + 1));
  }
  return config;
}
