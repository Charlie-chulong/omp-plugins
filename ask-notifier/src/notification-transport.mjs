const CHANNELS = ['wechat', 'qq'];
const LABELS = { wechat: '微信', qq: 'QQ' };
const inspectionError = (channel) => ({
  state: 'error', reason: `无法检查${LABELS[channel]}登录状态。`, accountId: null, version: null,
});

/** Owns both senders; only the QQ sender may own a temporary QQ session. */
export function createNotificationTransport({ wechat, qq, signal }) {
  const senders = { wechat, qq };
  const abort = new AbortController();
  let closing;

  return {
    async prepare({ signal: attemptSignal, maySend } = {}) {
      const signals = [abort.signal, signal, attemptSignal].filter(Boolean);
      const currentSignal = AbortSignal.any(signals);
      const mayContinue = () => !currentSignal.aborted && (maySend?.() ?? true);
      const inspected = await Promise.all(CHANNELS.map(async (channel) => {
        try { return await senders[channel].inspect(); }
        catch { return inspectionError(channel); }
      }));
      const connections = Object.fromEntries(CHANNELS.map((channel, index) => [channel, inspected[index]]));
      if (mayContinue() && CHANNELS.every((channel) => connections[channel].state === 'not_logged_in')) {
        try {
          connections.qq = await qq.ensureLoggedIn({ signal: currentSignal, mayContinue });
        } catch {
          connections.qq = mayContinue() ? inspectionError('qq') : {
            ...connections.qq, reason: '提醒已停止；不再等待 QQ 登录。',
          };
        }
      }
      return {
        connections,
        routes: mayContinue() ? CHANNELS.filter((channel) => connections[channel].state === 'ready') : [],
      };
    },
    send({ channel, requestId, text }) {
      if (!CHANNELS.includes(channel)) throw new TypeError('未知的提醒通道。');
      return senders[channel].send({ requestId, text });
    },
    async finishBatch({ mayClose } = {}) {
      const mayExit = () => !abort.signal.aborted && !signal?.aborted && (mayClose?.() ?? true);
      try {
        const inspection = await qq.finishBatch({ mayClose: mayExit });
        return inspection === null ? {} : { qq: inspection };
      } catch {
        return { qq: {
          state: 'error', reason: '临时 QQ 退出失败；已提交的提醒不受影响，请核对后手动退出 QQ。',
          accountId: null, version: null,
        } };
      }
    },
    close() {
      if (!closing) {
        abort.abort();
        closing = Promise.all(CHANNELS.map(async (channel) => senders[channel].close())).then(() => undefined);
      }
      return closing;
    },
  };
}
