import React, { useEffect, useRef, useState } from 'react';
import { BellRing, CheckCircle2, CirclePause, MessageSquare, RefreshCw, Send, WifiOff } from 'lucide-react';

const connectionLabels = { ready: '已登录', not_logged_in: '未登录', unsupported: '当前版本不支持', multiple_accounts: '检测到多个登录账号', not_installed: '未找到 QQ 安装', login_timeout: '等待 QQ 自动登录超时', error: '连接检查失败' };
const attemptLabels = { submitted: '已提交', unknown: '发送结果待核对', failed: '未能发送', error: '状态检查失败', not_logged_in: '未登录，已跳过', unsupported: '不支持，已跳过', multiple_accounts: '多个账号，已跳过', canceled: '问题已结束，未发送', skipped: '已跳过', partial: '部分提醒已提交', not_installed: '未找到 QQ', login_timeout: 'QQ 自动登录超时' };
const time = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(value);

export function ReminderPage({ api, theme }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let reading = false;
    const refresh = async () => {
      if (reading || lock.current) return;
      reading = true;
      try { const next = await api.read(); if (mounted.current) { setState(next); setError(''); } }
      catch (failure) { if (mounted.current) setError(failure.message || '无法读取提醒状态。'); }
      finally { reading = false; }
    };
    void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { mounted.current = false; clearInterval(interval); };
  }, [api]);
  async function run(operation, action) {
    if (lock.current) return;
    lock.current = true; setBusy(operation); setError('');
    try { const next = await action(); if (mounted.current) setState(next); }
    catch (failure) { if (mounted.current) setError(failure.message || '操作失败。'); }
    finally { lock.current = false; if (mounted.current) setBusy(null); }
  }
  const colors = theme.colors;
  const active = state?.mode === 'active';
  const connected = Object.values(state?.connections ?? {}).some(value => value?.state === 'ready');
  const ConnectionIcon = !active || !state?.enabled ? CirclePause : connected ? CheckCircle2 : WifiOff;
  return <main className="wn-page" style={{ '--wn-fg': colors.foreground, '--wn-muted': colors.foregroundMuted, '--wn-surface': colors.surface0, '--wn-accent': colors.accent, '--wn-danger': colors.statusDanger }}>
    <style>{`
      .wn-page{max-width:720px;margin:0 auto;padding:32px 24px 64px;color:var(--wn-fg);font-family:"Microsoft YaHei UI","PingFang SC",sans-serif;font-size:14px;line-height:1.6;overflow-wrap:anywhere}
      .wn-page *{box-sizing:border-box}.wn-page h1{font-size:26px;line-height:1.3;margin:0;font-weight:650;letter-spacing:-.02em}.wn-page h2{font-size:16px;margin:0 0 12px;font-weight:650}
      .wn-page p{margin:0}.wn-muted{color:var(--wn-muted)}.wn-title{display:flex;gap:12px;align-items:center;margin-bottom:12px}.wn-title svg{color:var(--wn-accent);flex:none}
      .wn-section{padding:24px 0;border-bottom:1px solid color-mix(in srgb,var(--wn-muted) 25%,transparent)}.wn-toggle{display:flex;justify-content:space-between;align-items:center;gap:24px;cursor:pointer}.wn-toggle strong{display:block;font-size:16px}.wn-toggle p{margin-top:4px}.wn-toggle input{width:20px;height:20px;flex:none;accent-color:var(--wn-accent);cursor:pointer}
      .wn-state{display:flex;gap:10px;align-items:center;margin-bottom:8px;font-weight:600}.wn-state svg{flex:none;color:var(--wn-accent)}.wn-meta{margin:12px 0 0;display:grid;gap:8px}.wn-meta div{display:flex;gap:16px;flex-wrap:wrap}.wn-meta dt{color:var(--wn-muted);min-width:72px}.wn-meta dd{margin:0}
      .wn-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.wn-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:8px 16px;border:1px solid color-mix(in srgb,var(--wn-muted) 55%,transparent);border-radius:8px;color:var(--wn-fg);background:var(--wn-surface);font:inherit;cursor:pointer}.wn-button:active:not(:disabled){transform:scale(.98)}.wn-button:disabled{opacity:.5;cursor:not-allowed}.wn-button:focus-visible,.wn-toggle input:focus-visible{outline:2px solid var(--wn-accent);outline-offset:4px}
      @media(hover:hover){.wn-button:hover:not(:disabled){border-color:var(--wn-accent)}}.wn-primary{border-color:var(--wn-accent)}.wn-note{display:flex;gap:10px;align-items:flex-start}.wn-note svg{flex:none;margin-top:3px;color:var(--wn-muted)}.wn-error{color:var(--wn-danger);margin-top:16px!important}.wn-preview{margin:12px 0 0;padding:16px;border-left:3px solid var(--wn-accent);background:color-mix(in srgb,var(--wn-muted) 7%,transparent);white-space:pre-wrap;font:inherit;line-height:1.8}.wn-page ::selection{background:color-mix(in srgb,var(--wn-accent) 30%,transparent)}
      @media(max-width:520px){.wn-page{padding:24px 16px 48px}.wn-toggle{gap:16px}.wn-button{flex:1}.wn-actions{gap:8px}}
    `}</style>
    <header><div className="wn-title"><BellRing size={26} aria-hidden="true" /><h1>QQ 与微信询问提醒</h1></div><p className="wn-muted">OMP 等你回答时，把问题和选项发到 QQ「我的手机」和微信「文件传输助手」。</p></header>
    <section className="wn-section">
      <label className="wn-toggle"><span><strong>自动提醒</strong><p className="wn-muted">都已登录时同时发；只登录一个时只发一个。都未登录时临时打开 QQ，整批提醒提交后退出；原已登录的 QQ 保持打开。</p></span><input type="checkbox" aria-label="自动提醒" checked={state?.enabled ?? false} disabled={!state || !active || Boolean(busy)} onChange={event => { const enabled = event.target.checked; void run('configure', () => api.configure(enabled)); }} /></label>
      {state && !active && <p className="wn-muted" style={{ marginTop: 12 }}>当前为管理模式。请先在插件管理中启用本插件。</p>}
    </section>
    <section className="wn-section" aria-labelledby="wn-connection">
      <h2 id="wn-connection">提醒状态</h2>
      <div className="wn-state" role="status"><ConnectionIcon size={18} aria-hidden="true" /><span>{!state ? '正在读取状态' : !active ? '管理模式，自动提醒未运行' : !state.enabled ? '自动提醒已关闭' : '已开启，收到新问题时选择已登录通道'}</span></div>
      <dl className="wn-meta">{[['qq', 'QQ · 我的手机'], ['wechat', '微信 · 文件传输助手']].map(([key, label]) => {
        const connection = state?.connections?.[key];
        return <div key={key}><dt>{label}</dt><dd>{connection ? connectionLabels[connection.state] : '尚未检查'}{connection?.reason && <p className="wn-muted">{connection.reason}</p>}{connection?.accountId && <p className="wn-muted">{connection.accountId}{connection.version ? ` · ${connection.version}` : ''}</p>}</dd></div>;
      })}{state && <div><dt>等待回答</dt><dd>{state.pendingCount} 个问题</dd></div>}</dl>
      <div className="wn-actions"><button className="wn-button wn-primary" disabled={!state?.enabled || !active || Boolean(busy)} onClick={() => void run('test', api.test)}><Send size={16} aria-hidden="true" />{busy === 'test' ? '正在发送…' : '发送测试提醒'}</button><button className="wn-button" disabled={Boolean(busy)} onClick={() => void run('refresh', api.read)}><RefreshCw size={16} aria-hidden="true" />{busy === 'refresh' ? '正在刷新…' : '刷新状态'}</button></div>
      {(error || state?.error) && <p className="wn-error" role="alert">{error || state.error}</p>}
    </section>
    <section className="wn-section"><h2>最近一次提醒</h2>{state?.lastAttempt ? <><p>{attemptLabels[state.lastAttempt.state] ?? state.lastAttempt.state}{state.lastAttempt.agentTitle ? ` · ${state.lastAttempt.agentTitle}` : ''}</p><p className="wn-muted">{time(state.lastAttempt.at)}</p><dl className="wn-meta">{Object.entries(state.lastAttempt.channels).map(([key, result]) => <div key={key}><dt>{key === 'qq' ? 'QQ' : '微信'}</dt><dd>{attemptLabels[result.state] ?? result.state}{result.reason && <p className="wn-muted">{result.reason}</p>}</dd></div>)}</dl>{state.lastAttempt.reason && <p className="wn-muted" style={{ marginTop: 8 }}>{state.lastAttempt.reason}</p>}{Object.values(state.lastAttempt.channels).some(result => result.state === 'unknown') && <p style={{ marginTop: 8 }}>请在对应通道核对。结果未知的通道不会自动重发，另一通道独立处理。</p>}</> : <p className="wn-muted">还没有提醒记录。</p>}</section>
    <section className="wn-section"><div className="wn-note"><MessageSquare size={18} aria-hidden="true" /><div><h2>收到后，回 OMP 回答</h2><p className="wn-muted">提醒会带上会话名、问题和选项。QQ、微信里的回复不会提交到 OMP。</p></div></div><blockquote className="wn-preview">{'【OMP 等你回答】\n会话：旅行计划\n\n周末选哪一天出发？\n1. 星期六（推荐）\n2. 星期日\n\n请回到 OMP 回答。'}</blockquote></section>
  </main>;
}
